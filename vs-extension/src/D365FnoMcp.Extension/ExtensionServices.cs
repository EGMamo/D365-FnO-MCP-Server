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

    /// <summary>The Node hybrid gateway the extension's gateway forwards to, when a custom models folder is set.</summary>
    private NodeGatewayProcess? nodeGateway;

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

    /// <summary>True while the Node gateway for the custom models folder runs and the extension's gateway forwards to it.</summary>
    public bool CustomModelsActive => this.nodeGateway is { HasExited: false };

    public async Task<McpGateway> EnsureGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        await this.gatewayLock.WaitAsync(cancellationToken);
        try
        {
            if (this.gateway is not null && this.nodeGateway?.HasExited != true)
            {
                return this.gateway;
            }

            if (this.gateway is not null)
            {
                this.Log("The Node gateway for custom models has stopped; starting the gateways again.");
                await this.StopGatewaysAsync();
            }

            (this.gateway, this.nodeGateway) = await this.StartGatewayAsync(serverUrl, apiKey, cancellationToken);
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
            McpGateway? previous = this.gateway;
            NodeGatewayProcess? previousNode = this.nodeGateway;
            (McpGateway created, NodeGatewayProcess? createdNode) = await this.StartGatewayAsync(serverUrl, apiKey, cancellationToken);
            this.gateway = created;
            this.nodeGateway = createdNode;
            if (previous is not null)
            {
                await previous.DisposeAsync();
            }

            if (previousNode is not null)
            {
                await previousNode.DisposeAsync();
            }

            return created;
        }
        finally
        {
            this.gatewayLock.Release();
        }
    }

    /// <summary>Saves the allowed tools and applies them to the running gateway without restarting it.</summary>
    public async Task SetAllowedToolsAsync(List<string>? allowedTools, CancellationToken cancellationToken)
    {
        await this.gatewayLock.WaitAsync(cancellationToken);
        try
        {
            ExtensionSettings settings = this.Settings.Load();
            settings.AllowedTools = allowedTools;
            this.Settings.Save(settings);
            if (this.gateway is not null)
            {
                this.gateway.AllowedTools = ToolSelection.ToSet(allowedTools);
            }
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
            await this.StopGatewaysAsync();
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

    /// <summary>Stops the running gateways; the caller holds <see cref="gatewayLock"/>.</summary>
    private async Task StopGatewaysAsync()
    {
        if (this.gateway is not null)
        {
            await this.gateway.DisposeAsync();
            this.gateway = null;
        }

        if (this.nodeGateway is not null)
        {
            await this.nodeGateway.DisposeAsync();
            this.nodeGateway = null;
        }
    }

    /// <summary>
    /// Starts the extension's gateway. With a custom models folder it first starts the Node hybrid
    /// gateway and forwards to it, so Copilot sees custom code merged with the hosted index; if that
    /// fails, it forwards to the hosted server and says so in the Output pane.
    /// </summary>
    private async Task<(McpGateway Gateway, NodeGatewayProcess? Node)> StartGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        string? sdkVersion = PackagesDirectoryLocator.SdkVersion(PackagesDirectoryLocator.Detect());
        ExtensionSettings settings = this.Settings.Load();
        NodeGatewayProcess? node = await this.StartNodeGatewayAsync(settings, serverUrl, apiKey, cancellationToken);
        var created = new McpGateway(this.GatewayHttp, this)
        {
            AllowedTools = ToolSelection.ToSet(settings.AllowedTools),
        };
        try
        {
            await created.StartAsync(
                node is null ? serverUrl : node.BaseUrl!.ToString(),
                node is null ? apiKey : node.Token,
                sdkVersion,
                cancellationToken);
        }
        catch
        {
            await created.DisposeAsync();
            if (node is not null)
            {
                await node.DisposeAsync();
            }

            throw;
        }

        this.Log($"Workspace gateway listening at {created.Endpoint}.");
        return (created, node);
    }

    private async Task<NodeGatewayProcess?> StartNodeGatewayAsync(ExtensionSettings settings, string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory))
        {
            return null;
        }

        var node = new NodeGatewayProcess(this.Http, this.Log);
        try
        {
            this.Log($"Starting the Node gateway for the custom models in {settings.CustomMetadataDirectory}; the first index can take a few minutes.");
            await node.StartAsync(
                new NodeGatewayOptions(
                    string.IsNullOrWhiteSpace(settings.NodeGatewayCommand) ? ExtensionSettings.DefaultNodeGatewayCommand : settings.NodeGatewayCommand,
                    serverUrl,
                    apiKey,
                    settings.CustomMetadataDirectory,
                    settings.PrivatePrefixes,
                    Path.Combine(Path.GetDirectoryName(this.Settings.Path)!, "node-gateway")),
                cancellationToken);
            this.Log($"Node gateway for custom models listening at {node.BaseUrl}.");
            return node;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or TimeoutException or ArgumentException or FormatException or System.ComponentModel.Win32Exception)
        {
            await node.DisposeAsync();
            this.Log($"Could not start the Node gateway for custom models: {ex.Message} Copilot gets the hosted index only until it starts (Extensions > D365 F&O MCP > Set Custom Models Folder...).");
            return null;
        }
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
