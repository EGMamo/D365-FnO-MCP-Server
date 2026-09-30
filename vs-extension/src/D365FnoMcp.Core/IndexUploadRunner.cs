namespace D365FnoMcp.Core;

/// <summary>Receives what an index-and-upload run does, for the tool window and the Output pane.</summary>
public interface IIndexUploadObserver
{
    void StepStarted(int index, int count, string name);

    void Log(string line, bool isError);

    void Stage(string stage, string message);

    void Progress(string stage, double percent, long done, long total);

    void Check(string name, bool ok, string expected, string actual);
}

public sealed record IndexUploadResult(bool Succeeded, string Message, string? Version = null, bool ChecksumVerified = false);

/// <summary>Runs the planned CLI steps in order and stops at the first failure.</summary>
public sealed class IndexUploadRunner
{
    private readonly CliLaunch launch;

    public IndexUploadRunner(CliLaunch launch)
    {
        this.launch = launch;
    }

    public async Task<IndexUploadResult> RunAsync(ExtensionSettings settings, JobSecrets secrets, IIndexUploadObserver observer, CancellationToken cancellationToken)
    {
        IReadOnlyList<CliStep> steps = IndexJob.Plan(settings, secrets);
        Directory.CreateDirectory(Path.GetDirectoryName(settings.IndexDbPath)!);
        if (settings.NewIndex)
        {
            observer.Log($"Deleting {settings.IndexDbPath} to build a new index.", false);
            IndexJob.DeleteIndex(settings.IndexDbPath);
        }

        string? version = null;
        bool checksumVerified = false;
        string? lastError = null;
        for (int i = 0; i < steps.Count; i++)
        {
            CliStep step = steps[i];
            observer.StepStarted(i, steps.Count, step.Name);
            observer.Log($"> {this.launch.Description} {string.Join(' ', step.Arguments.Select(Quote))}", false);
            int exitCode = await CliRunner.RunAsync(
                this.launch,
                step,
                (line, isError) =>
                {
                    ProgressEvent? progress = step.JsonProgress ? ProgressEvent.TryParse(line) : null;
                    if (progress is null)
                    {
                        observer.Log(line, isError && CliRunner.IsProblemLine(line));
                        return;
                    }

                    switch (progress.Kind)
                    {
                        case ProgressKind.Stage:
                            observer.Stage(progress.Stage ?? string.Empty, progress.Message ?? string.Empty);
                            observer.Log($"[{progress.Stage}] {progress.Message}", false);
                            break;
                        case ProgressKind.Progress:
                            observer.Progress(progress.Stage ?? string.Empty, progress.Percent ?? 0, progress.Done, progress.Total);
                            break;
                        case ProgressKind.Retry:
                            observer.Log($"  retry {progress.Message}", true);
                            break;
                        case ProgressKind.Check:
                            observer.Check(progress.Name ?? string.Empty, progress.Ok, progress.Expected ?? string.Empty, progress.Actual ?? string.Empty);
                            observer.Log($"  {(progress.Ok ? "OK  " : "FAIL")} {progress.Name}: expected {progress.Expected}, got {progress.Actual}", !progress.Ok);
                            if (progress.Name == "checksum")
                            {
                                checksumVerified = progress.Ok;
                            }

                            break;
                        case ProgressKind.Result:
                            version = (string?)progress.Raw?["index"]?["version"];
                            break;
                        case ProgressKind.Error:
                            lastError = progress.Message;
                            observer.Log($"ERROR {progress.Message}", true);
                            break;
                    }
                },
                cancellationToken);

            if (exitCode != 0)
            {
                return new IndexUploadResult(false, $"{step.Name} failed (exit code {exitCode}){(lastError is null ? string.Empty : $": {lastError}")}.");
            }
        }

        return checksumVerified
            ? new IndexUploadResult(true, $"Uploaded and verified; the server now serves {version ?? "the new index"}.", version, true)
            : new IndexUploadResult(false, "The upload finished without a verified checksum.");
    }

    /// <summary>For the log only: never used to build a real command line.</summary>
    private static string Quote(string argument) => argument.Contains(' ', StringComparison.Ordinal) ? $"\"{argument}\"" : argument;
}
