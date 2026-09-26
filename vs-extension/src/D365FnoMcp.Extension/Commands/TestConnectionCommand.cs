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

        string apiKey = this.services.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl)) ?? string.Empty;
        ConnectionReport report = await new ConnectionTester(this.services.Http).TestAsync(settings.ServerUrl, apiKey, cancellationToken);
        await this.services.WriteOutputAsync($"Connection test for {settings.ServerUrl}:{Environment.NewLine}{report.Summary()}", cancellationToken);
        await shell.ShowPromptAsync(
            $"{settings.ServerUrl}{Environment.NewLine}{Environment.NewLine}{report.Summary()}",
            report.Succeeded ? PromptOptions.InformationConfirm : PromptOptions.ErrorConfirm,
            cancellationToken);
    }
}
