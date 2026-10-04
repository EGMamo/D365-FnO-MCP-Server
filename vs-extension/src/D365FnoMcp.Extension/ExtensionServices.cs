using System.Threading.Channels;
using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Documents;
using Microsoft.VisualStudio.ProjectSystem.Query;

namespace D365FnoMcp.Extension;

/// <summary>Shared state: settings file, secret store, HTTP client and the Output pane.</summary>
internal sealed class ExtensionServices : IWorkspaceContextProvider, IAsyncDisposable
{
    private readonly VisualStudioExtensibility extensibility;
    private readonly SemaphoreSlim outputLock = new(1, 1);
    private readonly SemaphoreSlim gatewayLock = new(1, 1);
    private readonly Channel<string> logQueue = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    private OutputChannel? output;
    private McpGateway? gateway;

    public ExtensionServices(VisualStudioExtensibility extensibility)
    {
        this.extensibility = extensibility;
        _ = Task.Run(this.DrainLogAsync);
        _ = Task.Run(this.StartConfiguredGatewayAsync);
    }

    public SettingsStore Settings { get; } = new(SettingsStore.DefaultPath());

    public ISecretStore Secrets { get; } = new CredentialManagerSecretStore();

    /// <summary>Long enough for a server that is still downloading its index to answer /health.</summary>
    public HttpClient Http { get; } = new() { Timeout = TimeSpan.FromSeconds(60) };

    private HttpClient GatewayHttp { get; } = new() { Timeout = Timeout.InfiniteTimeSpan };

    public async Task<McpGateway> EnsureGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        await this.gatewayLock.WaitAsync(cancellationToken);
        try
        {
            if (this.gateway is not null)
            {
                return this.gateway;
            }

            this.gateway = await this.StartGatewayAsync(serverUrl, apiKey, cancellationToken);
            return this.gateway;
        }
        finally
        {
            this.gatewayLock.Release();
        }
    }

    /// <summary>Starts a gateway for new settings; the running one is stopped only once the new one listens.</summary>
    public async Task<McpGateway> RestartGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        await this.gatewayLock.WaitAsync(cancellationToken);
        try
        {
            McpGateway created = await this.StartGatewayAsync(serverUrl, apiKey, cancellationToken);
            McpGateway? previous = this.gateway;
            this.gateway = created;
            if (previous is not null)
            {
                await previous.DisposeAsync();
            }

            return created;
        }
        finally
        {
            this.gatewayLock.Release();
        }
    }

    public async Task WriteOutputAsync(string text, CancellationToken cancellationToken)
    {
        await this.outputLock.WaitAsync(cancellationToken);
        try
        {
            this.output ??= await this.extensibility.Views().Output.CreateOutputChannelAsync("D365 F&O MCP", cancellationToken);
            await this.output.Writer.WriteLineAsync(text);
        }
        finally
        {
            this.outputLock.Release();
        }
    }

    /// <summary>Queues a line for the Output pane; lines keep their order however many threads log.</summary>
    public void Log(string line) => this.logQueue.Writer.TryWrite(line);

    public async Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken)
    {
        string? sdkVersion = PackagesDirectoryLocator.SdkVersion(PackagesDirectoryLocator.Detect());
        string? solutionDirectory = null;
        try
        {
            IQueryResults<ISolutionSnapshot> solutions = await this.extensibility.Workspaces().QuerySolutionAsync(
                query => query.With(item => item.Directory),
                cancellationToken);
            solutionDirectory = solutions.FirstOrDefault()?.Directory;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            this.Log($"Workspace context query failed: {ex.Message}");
        }

        return WorkspaceContextResolver.Resolve(solutionDirectory, sdkVersion);
    }

    public async ValueTask DisposeAsync()
    {
        this.logQueue.Writer.TryComplete();
        this.output?.Dispose();
        await this.gatewayLock.WaitAsync();
        try
        {
            if (this.gateway is not null)
            {
                await this.gateway.DisposeAsync();
            }
        }
        finally
        {
            this.gatewayLock.Release();
        }

        this.Http.Dispose();
        this.GatewayHttp.Dispose();
        this.outputLock.Dispose();
        this.gatewayLock.Dispose();
    }

    private async Task DrainLogAsync()
    {
        await foreach (string line in this.logQueue.Reader.ReadAllAsync())
        {
            try
            {
                await this.WriteOutputAsync(line, CancellationToken.None);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // The Output pane is a copy of the window's log; losing a line there is harmless.
            }
        }
    }

    private async Task<McpGateway> StartGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        string? sdkVersion = PackagesDirectoryLocator.SdkVersion(PackagesDirectoryLocator.Detect());
        var created = new McpGateway(this.GatewayHttp, this);
        try
        {
            await created.StartAsync(serverUrl, apiKey, sdkVersion, cancellationToken);
        }
        catch
        {
            await created.DisposeAsync();
            throw;
        }

        this.Log($"Workspace gateway listening at {created.Endpoint}.");
        return created;
    }

    private async Task StartConfiguredGatewayAsync()
    {
        ExtensionSettings settings = this.Settings.Load();
        if (string.IsNullOrWhiteSpace(settings.ServerUrl) || string.IsNullOrWhiteSpace(settings.McpConfigurationPath))
        {
            return;
        }

        string? apiKey = this.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl));
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return;
        }

        try
        {
            McpGateway active = await this.EnsureGatewayAsync(settings.ServerUrl, apiKey, CancellationToken.None);

            // Another Visual Studio instance that is still running owns the entry; taking it over at
            // startup would cut that instance off. Configure Connection still replaces it on request.
            Uri? current = McpJsonFile.ReadServerEndpoint(settings.McpConfigurationPath, settings.McpServerName);
            if (current is not null && current != active.Endpoint &&
                await McpGateway.IsRunningAtAsync(this.GatewayHttp, current, CancellationToken.None))
            {
                this.Log($"Left '{settings.McpServerName}' in {settings.McpConfigurationPath} pointing at the gateway of another running Visual Studio instance ({current}).");
                return;
            }

            McpJsonFile.Write(settings.McpConfigurationPath, settings.McpServerName, active.Endpoint!, active.BearerToken);
            this.Log($"Refreshed '{settings.McpServerName}' in {settings.McpConfigurationPath}.");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            this.Log($"Could not start the configured workspace gateway: {ex.Message}");
        }
    }
}
