using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Validates the saved connection, then lets the user choose which tools the
/// local gateway offers to Visual Studio. The choice applies without a restart.
/// </summary>
[VisualStudioContribution]
internal sealed class SelectToolsCommand : Command
{
    private readonly ExtensionServices services;

    public SelectToolsCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.SelectTools.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.CheckBoxList, IconSettings.IconAndText),
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
            await shell.ShowPromptAsync("No server is configured yet. Use Configure Connection first.", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        string apiKey = this.services.Secrets.Read(SecretNames.ApiKey(serverUrl)) ?? string.Empty;
        if (apiKey.Length == 0)
        {
            await shell.ShowPromptAsync(
                $"No API key is saved for {serverUrl}. Use Extensions > D365 F&O MCP > Set API Key... to enter it.",
                PromptOptions.AlertConfirm,
                cancellationToken);
            return;
        }

        ConnectionReport report = await new ConnectionTester(this.services.Http).TestAsync(serverUrl, apiKey, cancellationToken);
        if (!report.Succeeded)
        {
            await this.services.WriteOutputAsync($"Connection test for {serverUrl}:{Environment.NewLine}{report.Summary()}", cancellationToken);
            await shell.ShowPromptAsync(
                $"The tool list needs a working connection:{Environment.NewLine}{Environment.NewLine}{report.Summary()}",
                PromptOptions.ErrorConfirm,
                cancellationToken);
            return;
        }

        (bool changed, List<string>? allowedTools) = await ToolPicker.ChooseAsync(shell, serverUrl, report.Tools, settings.AllowedTools, cancellationToken);
        if (!changed)
        {
            return;
        }

        await this.services.SetAllowedToolsAsync(allowedTools, cancellationToken);
        string summary = allowedTools is null ? "all tools" : $"{allowedTools.Count} tools";
        await this.services.WriteOutputAsync($"Allowed tools for {serverUrl}: {(allowedTools is null ? "all" : string.Join(", ", allowedTools))}.", cancellationToken);
        await shell.ShowPromptAsync(
            $"Saved: the gateway now offers {summary}.{Environment.NewLine}{Environment.NewLine}" +
            "If Copilot Chat still shows the old list, refresh the tools in its Tools menu or restart the d365-fno server there.",
            PromptOptions.InformationConfirm,
            cancellationToken);
    }
}
