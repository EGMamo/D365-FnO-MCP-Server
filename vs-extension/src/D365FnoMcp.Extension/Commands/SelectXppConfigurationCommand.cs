using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Chooses which XPP configuration (Manage local XPP configurations) the extension follows: its custom
/// metadata folder is indexed and served, and its version is sent to the hosted server. "Automatic" follows
/// the only configuration, or the most recently saved one when there are several.
/// </summary>
[VisualStudioContribution]
internal sealed class SelectXppConfigurationCommand : Command
{
    /// <summary>The choice that clears the pin; no configuration name can be empty.</summary>
    private const string Automatic = "";

    private readonly ExtensionServices services;

    public SelectXppConfigurationCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.SelectXppConfiguration.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.Settings, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        IReadOnlyList<XppConfiguration> configurations = XppConfigurations.List(XppConfigurations.DefaultFolder());
        if (configurations.Count == 0)
        {
            await shell.ShowPromptAsync(
                $"No XPP configuration was found in {XppConfigurations.DefaultFolder()}. Create one with Manage local XPP configurations in Visual Studio's Dynamics 365 menu.",
                PromptOptions.ErrorConfirm,
                cancellationToken);
            return;
        }

        ExtensionSettings settings = this.services.Settings.Load();
        XppConfigurationChoice automatic = XppConfigurations.Choose(configurations, pinnedName: null);
        // Prompt results must be value types: -1 is dismissed, 0 is automatic, i + 1 is configurations[i].
        var choices = new ChoiceResultCollection<int>
        {
            { $"Automatic (now '{automatic.Configuration?.Name}')", 0 },
        };
        for (int i = 0; i < configurations.Count; i++)
        {
            choices.Add($"{configurations[i].Name} {configurations[i].Version}".TrimEnd(), i + 1);
        }

        int current = configurations.ToList().FindIndex(c => c.Name.Equals(settings.XppConfigurationName, StringComparison.OrdinalIgnoreCase));
        PromptOptions<int> options = new PromptOptions<int>(choices, current < 0 ? 0 : current + 1, -1) with
        {
            Title = "D365 F&O MCP: XPP configuration",
        };

        int pickedIndex = await shell.ShowPromptAsync(
            "Which XPP configuration should the extension follow? Pick the one ticked Current in Manage local XPP configurations: " +
            "its custom metadata folder is indexed on this machine and its version is sent to the hosted server.",
            options,
            cancellationToken);
        string? picked = pickedIndex switch
        {
            < 0 => null,
            0 => Automatic,
            _ => configurations[pickedIndex - 1].Name,
        };
        if (picked is null || picked.Equals(settings.XppConfigurationName, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        settings.XppConfigurationName = picked;
        this.services.Settings.Save(settings);
        XppConfigurationChoice choice = this.services.ChooseXppConfiguration();
        if (choice.Configuration?.ModelStoreFolder is { Length: > 0 } folder && string.IsNullOrWhiteSpace(settings.CustomMetadataDirectory))
        {
            CustomModelsFolderReport report = CustomModelsFolder.Inspect(folder);
            if (!report.IsValid)
            {
                await shell.ShowPromptAsync($"Saved, but {report.Summary}", PromptOptions.AlertConfirm, cancellationToken);
            }
        }

        try
        {
            await this.services.RestartIfXppChangedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidOperationException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            await shell.ShowPromptAsync($"Saved, but the local MCP gateway could not restart: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        await shell.ShowPromptAsync($"Following {choice.Reason}", PromptOptions.InformationConfirm, cancellationToken);
    }
}
