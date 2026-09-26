using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.ToolWindows;
using Microsoft.VisualStudio.RpcContracts.RemoteUI;

namespace D365FnoMcp.Extension.IndexUpload;

/// <summary>Tool window that builds a new index and uploads it to the server.</summary>
[VisualStudioContribution]
internal sealed class IndexUploadToolWindow : ToolWindow
{
    private readonly ExtensionServices services;
    private IndexUploadControl? content;

    public IndexUploadToolWindow(ExtensionServices services)
    {
        this.services = services;
        this.Title = "D365 F&O MCP: Index and Upload";
    }

    public override ToolWindowConfiguration ToolWindowConfiguration => new()
    {
        Placement = ToolWindowPlacement.Floating,
    };

    public override Task<IRemoteUserControl> GetContentAsync(CancellationToken cancellationToken)
    {
        this.content ??= new IndexUploadControl(new IndexUploadViewModel(this.Extensibility, this.services));
        return Task.FromResult<IRemoteUserControl>(this.content);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            this.content?.Dispose();
        }

        base.Dispose(disposing);
    }
}
