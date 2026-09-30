using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Shell;
using Microsoft.VisualStudio.RpcContracts.ProgressReporting;

namespace D365FnoMcp.Extension;

/// <summary>
/// Check Index Freshness and Update Index: both use the settings saved by the
/// Index and Upload window, report in Visual Studio's background task list and
/// the Output pane, and answer with a prompt. No window of their own.
/// </summary>
internal sealed class IndexFreshness
{
    private const string Title = "D365 F&O MCP";
    private readonly VisualStudioExtensibility extensibility;
    private readonly ExtensionServices services;

    public IndexFreshness(VisualStudioExtensibility extensibility, ExtensionServices services)
    {
        this.extensibility = extensibility;
        this.services = services;
    }

    private ShellExtensibility Shell => this.extensibility.Shell();

    public async Task CheckAsync(CancellationToken cancellationToken)
    {
        ExtensionSettings settings = this.services.Settings.Load();
        IReadOnlyList<string> problems = IndexStatusCheck.Validate(settings, Directory.Exists);
        if (problems.Count > 0)
        {
            await this.Shell.ShowPromptAsync(string.Join(Environment.NewLine, problems), PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        string? apiKey = await this.ReadApiKeyAsync(settings, cancellationToken);
        CliLaunch? launch = await this.ResolveCliAsync(settings, cancellationToken);
        if (apiKey is null || launch is null)
        {
            return;
        }

        IndexStatusOutcome outcome;
        using (ProgressReporter progress = await this.Shell.StartProgressReportingAsync(
            "Checking the D365 F&O MCP index",
            new ProgressReporterOptions(isWorkCancellable: true),
            cancellationToken))
        {
            progress.Report(new ProgressStatus(null, $"Scanning {settings.PackagesDirectory}"));
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, progress.CancellationToken);
            this.services.Log($"Checking the index served by {settings.ServerUrl} against {settings.PackagesDirectory}");
            try
            {
                outcome = await IndexStatusCheck.RunAsync(launch, settings, apiKey, (line, _) => this.services.Log(line), cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (InvalidOperationException ex)
            {
                outcome = new IndexStatusOutcome(null, ex.Message);
            }
        }

        if (outcome.Report is null)
        {
            this.services.Log($"Index check failed: {outcome.Error}");
            await this.Shell.ShowPromptAsync($"The index check failed:{Environment.NewLine}{outcome.Error}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        string summary = outcome.Report.Summary(DateTimeOffset.UtcNow);
        this.services.Log(summary);
        foreach (Core.ChangedFile file in outcome.Report.Files)
        {
            this.services.Log($"  {file.Kind,-7} {file.Path}");
        }

        if (outcome.Report.UpToDate)
        {
            await this.Shell.ShowPromptAsync(summary, PromptOptions.InformationConfirm, cancellationToken);
            return;
        }

        var choices = new PromptOptions<UpdateChoice>
        {
            Title = Title,
            DismissedReturns = UpdateChoice.Close,
            DefaultChoiceIndex = 0,
        };
        choices.Choices.Add("Update index", UpdateChoice.Update);
        choices.Choices.Add("Close", UpdateChoice.Close);
        if (await this.Shell.ShowPromptAsync(summary, choices, cancellationToken) == UpdateChoice.Update)
        {
            await this.UpdateAsync(cancellationToken);
        }
    }

    /// <summary>Re-runs Index and Upload with the saved settings, updating the existing index in place.</summary>
    public async Task UpdateAsync(CancellationToken cancellationToken)
    {
        ExtensionSettings settings = this.services.Settings.Load();

        // Only changed files are re-parsed; a full rebuild stays a choice in the Index and Upload window.
        settings.NewIndex = false;
        IReadOnlyList<string> problems = IndexJob.Validate(settings, Directory.Exists);
        if (problems.Count > 0)
        {
            await this.Shell.ShowPromptAsync(
                $"{string.Join(Environment.NewLine, problems)}{Environment.NewLine}{Environment.NewLine}Open Index and Upload to choose these settings.",
                PromptOptions.AlertConfirm,
                cancellationToken);
            return;
        }

        string? apiKey = await this.ReadApiKeyAsync(settings, cancellationToken);
        CliLaunch? launch = await this.ResolveCliAsync(settings, cancellationToken);
        if (apiKey is null || launch is null)
        {
            return;
        }

        string? xrefPassword = null;
        if (settings.ImportXref && settings.XrefAuthentication == XrefAuthentication.SqlLogin)
        {
            string secretName = SecretNames.XrefPassword(settings.XrefServer, settings.XrefDatabase, settings.XrefUser);
            xrefPassword = this.services.Secrets.Read(secretName);
            if (xrefPassword is null)
            {
                xrefPassword = await this.Shell.ShowPromptAsync(
                    $"Password for SQL login '{settings.XrefUser}' on {settings.XrefServer} (stored in Windows Credential Manager):",
                    InputPromptOptions.Default with { Title = Title },
                    cancellationToken);
                if (string.IsNullOrEmpty(xrefPassword))
                {
                    return;
                }

                this.services.Secrets.Write(secretName, xrefPassword);
            }
        }

        if (!await this.services.IndexJobLock.WaitAsync(0, cancellationToken))
        {
            await this.Shell.ShowPromptAsync("An index run is already in progress.", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        IndexUploadResult result;
        try
        {
            using ProgressReporter progress = await this.Shell.StartProgressReportingAsync(
                "Updating the D365 F&O MCP index",
                new ProgressReporterOptions(isWorkCancellable: true),
                cancellationToken);
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, progress.CancellationToken);
            try
            {
                result = await new IndexUploadRunner(launch).RunAsync(
                    settings, new JobSecrets(apiKey, xrefPassword), new ProgressObserver(this.services, progress), cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                result = new IndexUploadResult(false, "Cancelled.");
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or ArgumentException)
            {
                result = new IndexUploadResult(false, ex.Message);
            }
        }
        finally
        {
            this.services.IndexJobLock.Release();
        }

        this.services.Log(result.Succeeded ? result.Message : $"Update failed: {result.Message}");
        await this.Shell.ShowPromptAsync(
            result.Succeeded ? result.Message : $"The index update failed: {result.Message}{Environment.NewLine}{Environment.NewLine}The Output pane (D365 F&O MCP) has the full log.",
            result.Succeeded ? PromptOptions.InformationConfirm : PromptOptions.ErrorConfirm,
            cancellationToken);
    }

    private async Task<string?> ReadApiKeyAsync(ExtensionSettings settings, CancellationToken cancellationToken)
    {
        string? apiKey = this.services.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl));
        if (string.IsNullOrEmpty(apiKey))
        {
            await this.Shell.ShowPromptAsync("No API key is saved for this server. Run Configure Connection first.", PromptOptions.AlertConfirm, cancellationToken);
            return null;
        }

        return apiKey;
    }

    private async Task<CliLaunch?> ResolveCliAsync(ExtensionSettings settings, CancellationToken cancellationToken)
    {
        try
        {
            return new CliLocator().Resolve(settings.Cli, settings.Node);
        }
        catch (FileNotFoundException ex)
        {
            await this.Shell.ShowPromptAsync(ex.Message, PromptOptions.ErrorConfirm, cancellationToken);
            return null;
        }
    }

    /// <summary>Prompt results must be a non-nullable value type, so dismissal has its own value.</summary>
    private enum UpdateChoice
    {
        Close,
        Update,
    }

    /// <summary>Sends a run's log to the Output pane and its stages to the background task list.</summary>
    private sealed class ProgressObserver : IIndexUploadObserver
    {
        private readonly ExtensionServices services;
        private readonly ProgressReporter progress;
        private string step = string.Empty;
        private int lastPercent = -1;

        public ProgressObserver(ExtensionServices services, ProgressReporter progress)
        {
            this.services = services;
            this.progress = progress;
        }

        public void StepStarted(int index, int count, string name)
        {
            this.step = $"{name} ({index + 1}/{count})";
            this.lastPercent = -1;
            this.services.Log($"== {this.step}");
            this.progress.Report(new ProgressStatus(null, this.step));
        }

        public void Log(string line, bool isError) => this.services.Log(line);

        public void Stage(string stage, string message) => this.progress.Report(new ProgressStatus(null, $"{this.step}: {message}"));

        public void Progress(string stage, double percent, long done, long total)
        {
            int whole = (int)Math.Clamp(percent, 0, 100);
            if (whole != this.lastPercent)
            {
                this.lastPercent = whole;
                this.progress.Report(new ProgressStatus(whole, $"{this.step}: {stage} {whole}%"));
            }
        }

        public void Check(string name, bool ok, string expected, string actual)
        {
        }
    }
}
