using D365FnoMcp.Extension.IndexUpload;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace D365FnoMcp.Extension.Commands;

/// <summary>Opens the Index and Upload window.</summary>
[VisualStudioContribution]
internal sealed class IndexAndUploadCommand : Command
{
    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.IndexAndUpload.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.Upload, IconSettings.IconAndText),
    };

    public override Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken) =>
        this.Extensibility.Shell().ShowToolWindowAsync<IndexUploadToolWindow>(activate: true, cancellationToken);
}
