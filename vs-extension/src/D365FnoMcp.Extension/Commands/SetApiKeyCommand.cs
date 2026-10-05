using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Enters or replaces the API key of the configured server without going through
/// the whole Configure Connection flow. The key goes to Windows Credential Manager.
/// </summary>
[VisualStudioContribution]
internal sealed class SetApiKeyCommand : Command
{
    private readonly ExtensionServices services;

    public SetApiKeyCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.SetApiKey.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.Key, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        ExtensionSettings settings = this.services.Settings.Load();
        string serverUrl;
        try
        {
            serverUrl = ServerUrl.NormalizeSecure(settings.ServerUrl);
        }
        catch (FormatException)
        {
            await shell.ShowPromptAsync(
                "No server is configured yet. Use Configure Connection first; it asks for the server URL and then the API key.",
                PromptOptions.AlertConfirm,
                cancellationToken);
            return;
        }

        string? apiKey = await ApiKeyPrompt.AskAsync(shell, this.services.Secrets, serverUrl, cancellationToken);
        if (apiKey is null)
        {
            return;
        }

        ConnectionReport report = await new ConnectionTester(this.services.Http).TestAsync(serverUrl, apiKey, cancellationToken);
        await this.services.WriteOutputAsync($"Connection test for {serverUrl}:{Environment.NewLine}{report.Summary()}", cancellationToken);
        if (!report.Succeeded &&
            !await shell.ShowPromptAsync($"The connection test failed:{Environment.NewLine}{Environment.NewLine}{report.Summary()}{Environment.NewLine}{Environment.NewLine}Save this key anyway?", PromptOptions.OKCancel.WithCancelAsDefault(), cancellationToken))
        {
            return;
        }

        // The running gateway holds the old key, so it is replaced and the managed .mcp.json
        // entry is pointed at the new one before the key is saved.
        if (!string.IsNullOrEmpty(settings.McpConfigurationPath))
        {
            try
            {
                McpGateway gateway = await this.services.RestartGatewayAsync(serverUrl, apiKey, cancellationToken);
                McpJsonFile.Write(settings.McpConfigurationPath, settings.McpServerName, gateway.Endpoint!, gateway.BearerToken);
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidOperationException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
            {
                await shell.ShowPromptAsync($"Could not restart the local MCP gateway with the new key: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
                return;
            }
        }

        this.services.Secrets.Write(SecretNames.ApiKey(serverUrl), apiKey);
        await this.services.WriteOutputAsync($"Saved the API key for {serverUrl} in Windows Credential Manager.", cancellationToken);
        await shell.ShowPromptAsync(
            string.IsNullOrEmpty(settings.McpConfigurationPath)
                ? $"Saved the API key for {serverUrl}. Run Configure Connection to write the gateway into .mcp.json."
                : $"Saved the API key for {serverUrl}. The local gateway now uses it.",
            PromptOptions.InformationConfirm,
            cancellationToken);
    }
}
