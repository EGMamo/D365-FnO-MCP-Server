using System.Diagnostics;
using System.Text;

namespace D365FnoMcp.Core;

/// <summary>Runs one CLI step and streams its output lines.</summary>
public static class CliRunner
{
    /// <summary>Returns the exit code; kills the process tree when <paramref name="cancellationToken"/> fires.</summary>
    public static async Task<int> RunAsync(
        CliLaunch launch,
        CliStep step,
        Action<string, bool> onLine,
        CancellationToken cancellationToken,
        string? workingDirectory = null)
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
            WorkingDirectory = workingDirectory ?? Path.GetTempPath(),
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

        process.StandardInput.Close();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using (cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
                // Already exited.
            }
        }))
        {
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdoutDone.Task, stderrDone.Task);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return process.ExitCode;
    }
}
