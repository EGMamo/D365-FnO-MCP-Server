using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace D365FnoMcp.Core;

/// <summary>What the extension hands the Node hybrid gateway when it starts it.</summary>
/// <param name="Command">How to run the server's CLI, e.g. <c>d365-fno-mcp-server</c> or <c>"C:\Program Files\nodejs\node.exe" C:\tools\d365\dist\src\index.js</c>; <c>gateway</c> is appended.</param>
/// <param name="HostedServerUrl">The hosted server the Node gateway forwards to.</param>
/// <param name="ApiKey">The hosted API key. It reaches the child through its environment only.</param>
/// <param name="CustomMetadataDirectory">The folder that holds the custom models the Node gateway indexes.</param>
/// <param name="PrivatePrefixes">Comma-separated name prefixes that must never be sent to the hosted server, or null.</param>
/// <param name="WorkingDirectory">The child's working directory, so no stray .env file is read.</param>
public sealed record NodeGatewayOptions(
    string Command,
    string HostedServerUrl,
    string ApiKey,
    string CustomMetadataDirectory,
    string? PrivatePrefixes,
    string WorkingDirectory);

/// <summary>
/// Runs the Node hybrid gateway (<c>d365-fno-mcp-server gateway</c>) as a child process on a
/// loopback port, so the extension's gateway can forward to it instead of to the hosted server.
/// The Node gateway indexes the custom models on this machine and merges them with the hosted
/// answers; nothing it reads from the custom models is sent upstream.
/// </summary>
public sealed class NodeGatewayProcess : IAsyncDisposable
{
    /// <summary>The Node gateway listens only after its first index of the custom models, which can take minutes.</summary>
    public static readonly TimeSpan DefaultStartTimeout = TimeSpan.FromMinutes(10);

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);
    private readonly HttpClient http;
    private readonly Action<string> log;
    private Process? process;

    public NodeGatewayProcess(HttpClient http, Action<string> log)
    {
        this.http = http;
        this.log = log;
    }

    /// <summary>Base URL of the running Node gateway, e.g. http://127.0.0.1:52011.</summary>
    public Uri? BaseUrl { get; private set; }

    /// <summary>The bearer token the Node gateway accepts; generated per start, never written to a file.</summary>
    public string Token { get; private set; } = string.Empty;

    public bool HasExited => this.process is null || this.process.HasExited;

    public async Task StartAsync(NodeGatewayOptions options, CancellationToken cancellationToken, TimeSpan? startTimeout = null)
    {
        if (this.process is not null)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(options.Command))
        {
            throw new ArgumentException("A command that runs d365-fno-mcp-server is required.", nameof(options));
        }

        if (!Directory.Exists(options.CustomMetadataDirectory))
        {
            throw new DirectoryNotFoundException($"The custom models folder '{options.CustomMetadataDirectory}' does not exist.");
        }

        Directory.CreateDirectory(options.WorkingDirectory);
        int port = FreeLoopbackPort();
        this.Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        ProcessStartInfo startInfo = BuildStartInfo(options, port, this.Token, OperatingSystem.IsWindows());

        var started = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        started.OutputDataReceived += (_, e) => this.Forward(e.Data);
        started.ErrorDataReceived += (_, e) => this.Forward(e.Data);
        if (!started.Start())
        {
            started.Dispose();
            throw new InvalidOperationException("The Node gateway process did not start.");
        }

        this.process = started;
        started.BeginOutputReadLine();
        started.BeginErrorReadLine();
        this.BaseUrl = new Uri($"http://127.0.0.1:{port}");

        try
        {
            await this.WaitUntilReadyAsync(startTimeout ?? DefaultStartTimeout, cancellationToken);
        }
        catch
        {
            await this.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        Process? running = this.process;
        this.process = null;
        if (running is null)
        {
            return;
        }

        try
        {
            if (!running.HasExited)
            {
                // The command may run through a shell, so the whole tree goes.
                running.Kill(entireProcessTree: true);
                using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await running.WaitForExitAsync(wait.Token);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            // Already gone, or it did not stop in time; the extension is shutting it down either way.
        }
        finally
        {
            running.Dispose();
        }
    }

    /// <summary>
    /// The child's command line and environment. The hosted key and the token travel in the
    /// environment only, never on the command line, where other processes could read them.
    /// </summary>
    internal static ProcessStartInfo BuildStartInfo(NodeGatewayOptions options, int port, string token, bool windows)
    {
        var startInfo = new ProcessStartInfo
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            WorkingDirectory = options.WorkingDirectory,
        };

        // A shell resolves npm's d365-fno-mcp-server shim (a .cmd file on Windows) and quoted paths.
        string commandLine = $"{options.Command.Trim()} gateway";
        if (windows)
        {
            startInfo.FileName = "cmd.exe";
            startInfo.Arguments = $"/d /s /c \"{commandLine}\"";
        }
        else
        {
            startInfo.FileName = "/bin/sh";
            startInfo.ArgumentList.Add("-c");
            startInfo.ArgumentList.Add($"exec {commandLine}");
        }

        IDictionary<string, string?> env = startInfo.Environment;
        env["D365_HOSTED_MCP_URL"] = ServerUrl.McpEndpoint(options.HostedServerUrl);
        env["D365_HOSTED_API_KEY"] = options.ApiKey;
        env["D365_HOSTED_API_KEY_FILE"] = string.Empty;
        env["D365_CUSTOM_METADATA_DIR"] = options.CustomMetadataDirectory;
        env["D365_PROJECT_DIR"] = string.Empty;

        // In memory: no token file, and two Visual Studio instances never share a database file.
        env["D365_LOCAL_INDEX_DB_PATH"] = ":memory:";
        env["D365_GATEWAY_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        env["D365_GATEWAY_TOKEN"] = token;
        env["D365_GATEWAY_PRIVATE_PREFIXES"] = options.PrivatePrefixes?.Trim() ?? string.Empty;
        return startInfo;
    }

    /// <summary>A loopback port that was free a moment ago.</summary>
    internal static int FreeLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private async Task WaitUntilReadyAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        var health = new Uri(this.BaseUrl!, "/health");
        while (true)
        {
            Process? running = this.process;
            if (running is null || running.HasExited)
            {
                string code = running is null ? "unknown" : running.ExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
                throw new InvalidOperationException($"The Node gateway exited (code {code}) before it was ready; its output is in the D365 F&O MCP Output pane.");
            }

            try
            {
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
                attempt.CancelAfter(TimeSpan.FromSeconds(3));
                using HttpResponseMessage response = await this.http.GetAsync(health, attempt.Token);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    return;
                }
            }
            catch (Exception ex) when (ex is HttpRequestException || (ex is OperationCanceledException && !deadline.IsCancellationRequested))
            {
                // Not listening yet: the first index of the custom models is still running.
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TimeoutException($"The Node gateway was not ready within {timeout.TotalMinutes:0.#} minutes.");
            }

            try
            {
                await Task.Delay(PollInterval, deadline.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TimeoutException($"The Node gateway was not ready within {timeout.TotalMinutes:0.#} minutes.");
            }
        }
    }

    private void Forward(string? line)
    {
        if (!string.IsNullOrWhiteSpace(line))
        {
            this.log($"[node gateway] {line}");
        }
    }
}
