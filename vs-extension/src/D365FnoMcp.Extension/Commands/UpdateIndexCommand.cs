using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace D365FnoMcp.Extension.Commands;

/// <summary>Updates the local index incrementally and uploads it, with the settings saved by Index and Upload.</summary>
[VisualStudioContribution]
internal sealed class UpdateIndexCommand : Command
{
    private readonly ExtensionServices services;

    public UpdateIndexCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.UpdateIndex.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.Refresh, IconSettings.IconAndText),
    };

    public override Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken) =>
        new IndexFreshness(this.Extensibility, this.services).UpdateAsync(cancellationToken);
}
