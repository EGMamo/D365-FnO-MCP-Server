using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Turns the cross-reference import on or off (off by default). When on, the Node gateway imports, from the XPP
/// configuration's cross-reference database, the compiler references that touch the custom models, each time it
/// starts, so find_usages lists call sites in custom code.
/// </summary>
[VisualStudioContribution]
internal sealed class CrossReferencesCommand : Command
{
    private readonly ExtensionServices services;

    public CrossReferencesCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.CrossReferences.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.FindSymbol, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        ExtensionSettings settings = this.services.Settings.Load();
        XppConfiguration? configuration = this.services.ChooseXppConfiguration().Configuration;
        string database = configuration?.CrossReferencesDatabaseName is { Length: > 0 } name
            ? $"{name} on {configuration.CrossReferencesDbServerName}"
            : "the XPP configuration's cross-reference database (none is configured now)";

        string question = settings.ImportCrossReferences
            ? $"Cross-reference import is ON: the compiler references that touch your custom models are imported from {database} when the gateway starts.{Environment.NewLine}{Environment.NewLine}Turn it off?"
            : $"Import the compiler references that touch your custom models from {database}, so find_usages lists call sites in custom code?{Environment.NewLine}{Environment.NewLine}" +
              "It runs when the gateway starts (Visual Studio start, a configuration switch, Configure Connection). It needs the msnodesqlv8 driver " +
              "(npm install -g msnodesqlv8) and an ODBC driver for SQL Server. A database without snapshot isolation is read with locks, which can " +
              "hold a compile's writes to it until the read ends.";
        if (!await shell.ShowPromptAsync(question, PromptOptions.OKCancel with { Title = "D365 F&O MCP: cross-references" }, cancellationToken))
        {
            return;
        }

        settings.ImportCrossReferences = !settings.ImportCrossReferences;
        this.services.Settings.Save(settings);
        try
        {
            await this.services.RestartAndPublishAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidOperationException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            await shell.ShowPromptAsync($"Saved, but the local MCP gateway could not restart: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        await shell.ShowPromptAsync(
            settings.ImportCrossReferences
                ? "Cross-reference import is on. Progress and any error are in the D365 F&O MCP Output pane."
                : "Cross-reference import is off; find_usages answers custom code from the hosted server only.",
            PromptOptions.InformationConfirm,
            cancellationToken);
    }
}
