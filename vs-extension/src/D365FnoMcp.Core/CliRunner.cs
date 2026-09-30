using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace D365FnoMcp.Core;

/// <summary>Runs one CLI step and streams its output lines.</summary>
public static class CliRunner
{
    /// <summary>How long a step that stops on a closed stdin gets to clean up before it is killed.</summary>
    public static readonly TimeSpan GracefulStopTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Returns the exit code. When <paramref name="cancellationToken"/> fires, a step that
    /// <see cref="CliStep.StopsOnStdinClose"/> has its stdin closed so it can abort cleanly,
    /// and is killed only if it is still running after <see cref="GracefulStopTimeout"/>;
    /// any other step's process tree is killed at once.
    /// </summary>
    public static async Task<int> RunAsync(
        CliLaunch launch,
        CliStep step,
        Action<string, bool> onLine,
        CancellationToken cancellationToken)
    {
        var info = new ProcessStartInfo(launch.FileName)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            // Every path is passed as a full path; a neutral folder keeps a project .env from filling in settings.
            WorkingDirectory = Path.GetTempPath(),
        };
        foreach (string argument in launch.PrefixArguments.Concat(step.Arguments))
        {
            info.ArgumentList.Add(argument);
        }

        // The CLI reads a .env from its working directory; none of the caller's D365_/MCP_ settings may leak in.
        foreach (string key in info.Environment.Keys.Where(key => key.StartsWith("D365_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("MCP_", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            info.Environment.Remove(key);
        }

        // The CLI logs DEBUG lines unless told otherwise; INFO still shows indexing progress.
        info.Environment["MCP_LOG_LEVEL"] = "INFO";

        foreach ((string key, string value) in step.Environment)
        {
            info.Environment[key] = value;
        }

        using var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        var stdoutDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stderrDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null)
            {
                stdoutDone.TrySetResult();
            }
            else
            {
                onLine(e.Data, false);
            }
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null)
            {
                stderrDone.TrySetResult();
            }
            else
            {
                onLine(e.Data, true);
            }
        };

        try
        {
            process.Start();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            throw new InvalidOperationException($"Could not start '{launch.FileName}': {ex.Message}. Is Node.js 24 installed and on PATH?", ex);
        }

        if (!step.StopsOnStdinClose)
        {
            process.StandardInput.Close();
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using (cancellationToken.Register(() =>
        {
            if (step.StopsOnStdinClose)
            {
                try
                {
                    process.StandardInput.Close();
                }
                catch (Exception ex) when (ex is IOException or InvalidOperationException or ObjectDisposedException)
                {
                    // Already exited.
                }

                _ = Task.Delay(GracefulStopTimeout).ContinueWith(_ => Kill(process), TaskScheduler.Default);
            }
            else
            {
                Kill(process);
            }
        }))
        {
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdoutDone.Task, stderrDone.Task);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return process.ExitCode;
    }

    /// <summary>
    /// True for a stderr line worth flagging: anything except the CLI's own DEBUG/INFO log
    /// records (<c>{"level":"INFO",...}</c>), which it always writes to stderr.
    /// </summary>
    public static bool IsProblemLine(string line)
    {
        if (!line.StartsWith('{'))
        {
            return true;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("level", out JsonElement level)
                && level.ValueKind == JsonValueKind.String)
            {
                return level.GetString() is not ("DEBUG" or "INFO");
            }
        }
        catch (JsonException)
        {
            // Not a log record.
        }

        return true;
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or ObjectDisposedException)
        {
            // Already exited, exiting, or disposed after the run returned.
        }
    }
}
