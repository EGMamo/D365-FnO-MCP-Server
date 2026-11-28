using System.Threading.Channels;
using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Documents;
using Microsoft.VisualStudio.ProjectSystem.Query;

namespace D365FnoMcp.Extension;

/// <summary>Shared state: settings file, secret store, HTTP client and the Output pane.</summary>
internal sealed class ExtensionServices : IWorkspaceContextProvider, IVisualStudioProjects, IAsyncDisposable
{
    private readonly VisualStudioExtensibility extensibility;
    private readonly SemaphoreSlim outputLock = new(1, 1);
    private readonly SemaphoreSlim gatewayLock = new(1, 1);
    private readonly Channel<string> logQueue = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    private OutputChannel? output;
    private McpGateway? gateway;

    /// <summary>The Node hybrid gateway the extension's gateway forwards to, when a custom models folder is set.</summary>
    private NodeGatewayProcess? nodeGateway;

    /// <summary>The lock on the Node gateway's index file, held while it runs; null when it indexes in memory.</summary>
    private IndexFileLock? indexLock;

    /// <summary>What the running gateways were started for; a change to it restarts them.</summary>
    private XppSnapshot? startedFor;

    private FileSystemWatcher? xppWatcher;
    private CancellationTokenSource? xppDebounce;

    public ExtensionServices(VisualStudioExtensibility extensibility)
    {
        this.extensibility = extensibility;
        _ = Task.Run(this.DrainLogAsync);
        _ = Task.Run(this.StartConfiguredGatewayAsync);
        this.WatchXppConfigurations();
    }

    /// <summary>The parts of the XPP configuration and settings a running gateway depends on.</summary>
    private sealed record XppSnapshot(string? Name, string? Version, string? CustomFolder);

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
            IndexFileLock? previousLock = this.indexLock;

            // The previous Node gateway may hold the index file the new one wants (same configuration),
            // so it is stopped first; the extension's own gateway keeps answering until the new one listens.
            if (previousNode is not null)
            {
                await previousNode.DisposeAsync();
                this.nodeGateway = null;
            }

            previousLock?.Dispose();
            this.indexLock = null;

            (McpGateway created, NodeGatewayProcess? createdNode) = await this.StartGatewayAsync(serverUrl, apiKey, cancellationToken);
            this.gateway = created;
            this.nodeGateway = createdNode;
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

    /// <summary>The XPP configuration the extension follows now, and why.</summary>
    public XppConfigurationChoice ChooseXppConfiguration() =>
        XppConfigurations.ChooseDefault(this.Settings.Load().XppConfigurationName);

    /// <summary>The custom models folder in effect: the override in the settings, else the XPP configuration's.</summary>
    public static string? EffectiveCustomFolder(ExtensionSettings settings, XppConfiguration? configuration) =>
        !string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory)
            ? settings.CustomMetadataDirectory
            : configuration?.ModelStoreFolder;

    /// <summary>
    /// Restarts the gateways for the current settings and XPP configuration and points the managed .mcp.json at
    /// the new endpoint. Does nothing before Configure Connection has run.
    /// </summary>
    public async Task<McpGateway?> RestartAndPublishAsync(CancellationToken cancellationToken)
    {
        ExtensionSettings settings = this.Settings.Load();
        if (string.IsNullOrWhiteSpace(settings.ServerUrl) || string.IsNullOrWhiteSpace(settings.McpConfigurationPath))
        {
            return null;
        }

        string? apiKey = this.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl));
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return null;
        }

        McpGateway gateway = await this.RestartGatewayAsync(settings.ServerUrl, apiKey, cancellationToken);
        McpJsonFile.Write(settings.McpConfigurationPath, settings.McpServerName, gateway.Endpoint!, gateway.BearerToken);
        return gateway;
    }

    public async Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken)
    {
        XppConfiguration? configuration = this.ChooseXppConfiguration().Configuration;
        string? sdkVersion = configuration?.Version ?? PackagesDirectoryLocator.SdkVersion(PackagesDirectoryLocator.Detect());
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

        return WorkspaceContextResolver.Resolve(solutionDirectory, sdkVersion) with { XppConfiguration = configuration?.Name };
    }

    public async Task<string> FindProjectAsync(string? projectName, CancellationToken cancellationToken)
    {
        IQueryResults<IProjectSnapshot> projects = await this.extensibility.Workspaces().QueryProjectsAsync(
            query => query.With(project => new { project.Name, project.Path }),
            cancellationToken);
        List<IProjectSnapshot> finOps = projects
            .Where(project => project.Path?.EndsWith(".rnrproj", StringComparison.OrdinalIgnoreCase) == true)
            .ToList();
        List<IProjectSnapshot> matches = string.IsNullOrWhiteSpace(projectName)
            ? finOps
            : finOps.Where(project => string.Equals(project.Name, projectName, StringComparison.OrdinalIgnoreCase)).ToList();
        return matches.Count switch
        {
            1 => matches[0].Path!,
            0 when finOps.Count == 0 => throw new InvalidOperationException("No Finance and Operations project (.rnrproj) is open in Visual Studio."),
            0 => throw new InvalidOperationException($"No open project is named '{projectName}'. Open projects: {string.Join(", ", finOps.Select(project => project.Name))}."),
            _ => throw new InvalidOperationException($"Several projects are open; name one in 'project': {string.Join(", ", matches.Select(project => project.Name))}."),
        };
    }

    public async Task AddFilesAsync(string projectPath, IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        await this.extensibility.Workspaces().UpdateProjectsAsync(
            query => query.Where(project => project.Path == projectPath),
            project => project.AddFiles(paths),
            cancellationToken);
        IQueryResults<IProjectSnapshot> saved = await this.extensibility.Workspaces().QueryProjectsAsync(
            query => query.Where(project => project.Path == projectPath),
            cancellationToken);
        foreach (IProjectSnapshot project in saved)
        {
            await project.SaveAsync(cancellationToken);
        }

        this.Log($"Asked Visual Studio to add {paths.Count} file(s) to {Path.GetFileName(projectPath)}.");
    }

    public async Task BuildAsync(string projectPath, CancellationToken cancellationToken)
    {
        IQueryResults<IProjectSnapshot> projects = await this.extensibility.Workspaces().QueryProjectsAsync(
            query => query.Where(project => project.Path == projectPath),
            cancellationToken);
        this.Log($"Building {Path.GetFileName(projectPath)} for {McpGateway.BuildProjectToolName}.");
        foreach (IProjectSnapshot project in projects)
        {
            await project.BuildAsync(cancellationToken);
        }
    }

    public async ValueTask DisposeAsync()
    {
        this.logQueue.Writer.TryComplete();
        this.output?.Dispose();
        this.xppWatcher?.Dispose();
        if (this.xppDebounce is not null)
        {
            await this.xppDebounce.CancelAsync();
        }
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

        this.indexLock?.Dispose();
        this.indexLock = null;
    }

    /// <summary>
    /// Starts the extension's gateway. With a custom models folder it first starts the Node hybrid
    /// gateway and forwards to it, so Copilot sees custom code merged with the hosted index; if that
    /// fails, it forwards to the hosted server and says so in the Output pane.
    /// </summary>
    private async Task<(McpGateway Gateway, NodeGatewayProcess? Node)> StartGatewayAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        ExtensionSettings settings = this.Settings.Load();
        XppConfigurationChoice choice = XppConfigurations.ChooseDefault(settings.XppConfigurationName);
        XppConfiguration? configuration = choice.Configuration;
        this.Log($"Following {choice.Reason}");
        string? sdkVersion = configuration?.Version ?? PackagesDirectoryLocator.SdkVersion(PackagesDirectoryLocator.Detect());
        string? customFolder = EffectiveCustomFolder(settings, configuration);
        this.startedFor = new XppSnapshot(configuration?.Name, configuration?.Version, customFolder);

        NodeGatewayProcess? node = await this.StartNodeGatewayAsync(settings, customFolder, configuration, serverUrl, apiKey, cancellationToken);
        var created = new McpGateway(this.GatewayHttp, this, this)
        {
            AllowedTools = ToolSelection.ToSet(settings.AllowedTools),
            CustomMetadataDirectory = node is null || string.IsNullOrWhiteSpace(customFolder) ? null : customFolder,
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

    private async Task<NodeGatewayProcess?> StartNodeGatewayAsync(
        ExtensionSettings settings,
        string? customFolder,
        XppConfiguration? configuration,
        string serverUrl,
        string apiKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(customFolder))
        {
            return null;
        }

        string source = string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory)
            ? $"the custom metadata folder of XPP configuration '{configuration?.Name}'"
            : "the custom models folder set in Extensions > D365 F&O MCP > Set Custom Models Folder...";
        CustomModelsFolderReport report = CustomModelsFolder.Inspect(customFolder);
        if (!report.IsValid)
        {
            this.Log($"Custom models are not indexed: {source} is not usable. {report.Summary}");
            return null;
        }

        this.Log($"Custom models from {source} ({customFolder}): {report.Summary}");
        if (configuration is not null && !string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory) &&
            !CustomModelsFolder.SameFolder(settings.CustomMetadataDirectory, configuration.ModelStoreFolder))
        {
            this.Log($"Note: this differs from XPP configuration '{configuration.Name}', whose custom metadata folder is {configuration.ModelStoreFolder}.");
        }

        // One index file per configuration (or per override folder), so each is indexed once and a switch back is quick.
        string indexes = Path.Combine(Path.GetDirectoryName(this.Settings.Path)!, "indexes");
        string indexPath = string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory) && configuration is not null
            ? IndexFileLock.PathFor(indexes, configuration)
            : Path.Combine(indexes, "custom-" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(customFolder).ToUpperInvariant())))[..16] + ".db");
        IndexFileLock? fileLock = IndexFileLock.TryAcquire(indexPath);
        if (fileLock is null)
        {
            this.Log("Another Visual Studio instance is using the saved index for these custom models; indexing them in memory instead.");
        }

        string? xref = null;
        if (settings.ImportCrossReferences)
        {
            xref = configuration is null ? null : XppConfigurations.CrossReferencesConnectionString(configuration);
            this.Log(xref is null
                ? "Cross-reference import is on, but the XPP configuration names no cross-reference database; find_usages stays hosted-only for custom code."
                : $"Importing the custom models' compiler cross-references from {configuration!.CrossReferencesDatabaseName} on {configuration.CrossReferencesDbServerName} once they are indexed.");
        }

        var node = new NodeGatewayProcess(this.Http, this.Log);
        try
        {
            this.Log($"Starting the Node gateway for the custom models in {customFolder}; the first index can take a few minutes.");
            await node.StartAsync(
                new NodeGatewayOptions(
                    string.IsNullOrWhiteSpace(settings.NodeGatewayCommand) ? ExtensionSettings.DefaultNodeGatewayCommand : settings.NodeGatewayCommand,
                    serverUrl,
                    apiKey,
                    customFolder,
                    settings.PrivatePrefixes,
                    Path.Combine(Path.GetDirectoryName(this.Settings.Path)!, "node-gateway"),
                    settings.StandardIndexPath,
                    fileLock?.IndexPath,
                    xref),
                cancellationToken);
            this.Log($"Node gateway for custom models listening at {node.BaseUrl}.");
            this.indexLock = fileLock;
            return node;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or TimeoutException or ArgumentException or FormatException or System.ComponentModel.Win32Exception)
        {
            fileLock?.Dispose();
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

    /// <summary>
    /// Watches Visual Studio's XPP configurations. When the one the extension follows changes (another is
    /// selected, or its custom metadata folder or version is edited), the gateways restart for it, so the
    /// custom models served are always those of the configuration in use.
    /// </summary>
    private void WatchXppConfigurations()
    {
        string folder = XppConfigurations.DefaultFolder();
        if (!Directory.Exists(folder))
        {
            return;
        }

        try
        {
            this.xppWatcher = new FileSystemWatcher(folder, "*.json")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
                IncludeSubdirectories = false,
            };
            this.xppWatcher.Changed += (_, _) => this.OnXppConfigurationsChanged();
            this.xppWatcher.Created += (_, _) => this.OnXppConfigurationsChanged();
            this.xppWatcher.Deleted += (_, _) => this.OnXppConfigurationsChanged();
            this.xppWatcher.Renamed += (_, _) => this.OnXppConfigurationsChanged();
            this.xppWatcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            this.Log($"Could not watch the XPP configurations in {folder}: {ex.Message} A configuration switch takes effect when Visual Studio restarts.");
        }
    }

    /// <summary>A save fires several events; act once the folder has been quiet for two seconds.</summary>
    private void OnXppConfigurationsChanged()
    {
        var debounce = new CancellationTokenSource();
        Interlocked.Exchange(ref this.xppDebounce, debounce)?.Cancel();
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), debounce.Token);
                await this.RestartIfXppChangedAsync(debounce.Token);
            }
            catch (OperationCanceledException)
            {
                // A later change superseded this one.
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                this.Log($"Could not restart the gateway for the changed XPP configuration: {ex.Message}");
            }
        });
    }

    /// <summary>Restarts the gateways when the configuration, version or custom folder they serve has changed.</summary>
    public async Task RestartIfXppChangedAsync(CancellationToken cancellationToken)
    {
        if (this.gateway is null)
        {
            return;
        }

        ExtensionSettings settings = this.Settings.Load();
        XppConfiguration? configuration = XppConfigurations.ChooseDefault(settings.XppConfigurationName).Configuration;
        var now = new XppSnapshot(configuration?.Name, configuration?.Version, EffectiveCustomFolder(settings, configuration));
        if (now == this.startedFor)
        {
            return;
        }

        this.Log($"The XPP configuration changed ({this.startedFor?.Name ?? "none"} -> {now.Name ?? "none"}); restarting the gateway for it.");
        await this.RestartAndPublishAsync(cancellationToken);
    }
}
