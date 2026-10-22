using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Sets the folder of custom models to index on this machine. With a folder, the extension runs the
/// Node hybrid gateway and forwards to it, so Copilot sees custom code merged with the hosted index.
/// An optional standard index lets the tools the hosted server would answer alone see custom code too.
/// An empty folder turns this off again.
/// </summary>
[VisualStudioContribution]
internal sealed class SetCustomModelsCommand : Command
{
    private readonly ExtensionServices services;

    public SetCustomModelsCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.SetCustomModels.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.FolderOpened, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        ExtensionSettings settings = this.services.Settings.Load();

        string? folder = await shell.ShowPromptAsync(
            $"Folder that holds your custom models (the model folders with your AxClass, AxTable... XML).{Environment.NewLine}{Environment.NewLine}" +
            "They are indexed on this machine and merged with the hosted index; their contents are never sent to the hosted server. " +
            "Requires Node.js 24 and the d365-fno-mcp-server command on the PATH (npm link in a clone of the server's repository). Leave empty to turn this off.",
            InputPromptOptions.Default with { Title = "D365 F&O MCP: custom models", DefaultText = settings.CustomMetadataDirectory },
            cancellationToken);
        if (folder is null)
        {
            return;
        }

        folder = folder.Trim().Trim('"');
        if (folder.Length > 0 && !Directory.Exists(folder))
        {
            await shell.ShowPromptAsync($"The folder '{folder}' does not exist.", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        string? prefixes = settings.PrivatePrefixes;
        if (folder.Length > 0)
        {
            prefixes = await shell.ShowPromptAsync(
                "Prefixes of your own object names, comma-separated (for example Contoso,Fabrikam). " +
                "A call whose arguments contain a name with one of them is never sent to the hosted server. Leave empty for none.",
                InputPromptOptions.Default with { Title = "D365 F&O MCP: private prefixes", DefaultText = settings.PrivatePrefixes },
                cancellationToken);
            if (prefixes is null)
            {
                return;
            }
        }

        string? standardIndex = settings.StandardIndexPath;
        if (folder.Length > 0)
        {
            standardIndex = await shell.ShowPromptAsync(
                "Optional: an index of the standard application (a d365_index.db built with the server's index command over your PackagesLocalDirectory). " +
                "With one, tools such as security paths, SoD checks, BP findings and the generators run on this machine over the standard and custom models together, " +
                "instead of on the hosted server, which never sees your custom code. It is only read. Leave empty to keep those tools on the hosted server.",
                InputPromptOptions.Default with { Title = "D365 F&O MCP: standard index", DefaultText = settings.StandardIndexPath },
                cancellationToken);
            if (standardIndex is null)
            {
                return;
            }

            standardIndex = standardIndex.Trim().Trim('"');
            if (standardIndex.Length > 0 && !File.Exists(standardIndex))
            {
                await shell.ShowPromptAsync($"The file '{standardIndex}' does not exist.", PromptOptions.ErrorConfirm, cancellationToken);
                return;
            }
        }

        settings.CustomMetadataDirectory = folder;
        settings.PrivatePrefixes = prefixes?.Trim() ?? string.Empty;
        settings.StandardIndexPath = standardIndex?.Trim() ?? string.Empty;
        this.services.Settings.Save(settings);

        string? apiKey = string.IsNullOrWhiteSpace(settings.ServerUrl) ? null : this.services.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl));
        if (string.IsNullOrEmpty(settings.McpConfigurationPath) || string.IsNullOrEmpty(apiKey))
        {
            await shell.ShowPromptAsync(
                "Saved. Run Configure Connection to connect to the hosted server; the custom models are indexed once the gateway starts.",
                PromptOptions.InformationConfirm,
                cancellationToken);
            return;
        }

        try
        {
            McpGateway gateway = await this.services.RestartGatewayAsync(settings.ServerUrl, apiKey, cancellationToken);
            McpJsonFile.Write(settings.McpConfigurationPath, settings.McpServerName, gateway.Endpoint!, gateway.BearerToken);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidOperationException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            await shell.ShowPromptAsync($"Could not restart the local MCP gateway: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        string message = folder.Length == 0
            ? "Saved. Custom models are no longer indexed; the gateway forwards to the hosted server only."
            : this.services.CustomModelsActive
                ? settings.StandardIndexPath.Length > 0
                    ? $"Saved. Custom models in {folder} are indexed on this machine, merged with the hosted index and laid over the standard index for the tools that run locally."
                    : $"Saved. Custom models in {folder} are indexed on this machine and merged with the hosted index."
                : "Saved, but the Node gateway did not start, so the gateway forwards to the hosted server only. The reason is in the D365 F&O MCP Output pane.";
        await shell.ShowPromptAsync(
            message,
            this.services.CustomModelsActive || folder.Length == 0 ? PromptOptions.InformationConfirm : PromptOptions.AlertConfirm,
            cancellationToken);
    }
}
