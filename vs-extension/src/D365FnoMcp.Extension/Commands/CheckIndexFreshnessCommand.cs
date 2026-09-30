using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace D365FnoMcp.Extension.Commands;

/// <summary>Compares the index the server serves with the local packages folder and offers to update it.</summary>
[VisualStudioContribution]
internal sealed class CheckIndexFreshnessCommand : Command
{
    private readonly ExtensionServices services;

    public CheckIndexFreshnessCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.CheckIndexFreshness.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.StatusInformation, IconSettings.IconAndText),
    };

    public override Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken) =>
        new IndexFreshness(this.Extensibility, this.services).CheckAsync(cancellationToken);
}
