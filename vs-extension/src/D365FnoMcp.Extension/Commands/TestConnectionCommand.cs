using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>Checks the saved connection: health, API key, MCP tools, served index and upload permission.</summary>
[VisualStudioContribution]
internal sealed class TestConnectionCommand : Command
{
    private readonly ExtensionServices services;

    public TestConnectionCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.TestConnection.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.StatusOK, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        ExtensionSettings settings = this.services.Settings.Load();
        if (string.IsNullOrEmpty(settings.ServerUrl))
        {
            await shell.ShowPromptAsync("No server is configured yet. Use Configure Connection first.", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        try
        {
            ServerUrl.NormalizeSecure(settings.ServerUrl);
        }
        catch (FormatException ex)
        {
            await shell.ShowPromptAsync($"The saved server URL is not valid ({ex.Message}). Use Configure Connection to fix it.", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        string apiKey = this.services.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl)) ?? string.Empty;
        if (apiKey.Length == 0)
        {
            await shell.ShowPromptAsync(
                $"No API key is saved for {settings.ServerUrl}. Use Extensions > D365 F&O MCP > Set API Key... to enter it.",
                PromptOptions.AlertConfirm,
                cancellationToken);
            return;
        }

        ConnectionReport report = await new ConnectionTester(this.services.Http).TestAsync(settings.ServerUrl, apiKey, cancellationToken);
        await this.services.WriteOutputAsync($"Connection test for {settings.ServerUrl}:{Environment.NewLine}{report.Summary()}", cancellationToken);
        await shell.ShowPromptAsync(
            $"{settings.ServerUrl}{Environment.NewLine}{Environment.NewLine}{report.Summary()}",
            report.Succeeded ? PromptOptions.InformationConfirm : PromptOptions.ErrorConfirm,
            cancellationToken);
    }
}
