using D365FnoMcp.Extension.Commands;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace D365FnoMcp.Extension;

/// <summary>
/// D365 F&amp;O MCP for Visual Studio: connects Copilot (and any other MCP client
/// in Visual Studio) to the D365 F&amp;O MCP server, and builds and uploads a new
/// metadata index to it.
/// </summary>
[VisualStudioContribution]
internal sealed class ExtensionEntrypoint : Microsoft.VisualStudio.Extensibility.Extension
{
    public override ExtensionConfiguration ExtensionConfiguration => new()
    {
        Metadata = new(
            id: "D365FnoMcp.VisualStudio.7c1f6f0e-1f0a-4e0b-9f53-2f6b1d1c9a41",
            version: this.ExtensionAssemblyVersion,
            publisherName: "D365 FnO MCP Server contributors",
            displayName: "D365 F&O MCP",
            description: "Connects Visual Studio's MCP clients to a D365 F&O MCP server, and indexes PackagesLocalDirectory and the XRef database and uploads the index to it."),
    };

    [VisualStudioContribution]
    public static MenuConfiguration D365Menu => new("%D365FnoMcp.Menu.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ExtensionsMenu],
        Children =
        [
            MenuChild.Command<ConfigureConnectionCommand>(),
            MenuChild.Command<TestConnectionCommand>(),
            MenuChild.Separator,
            MenuChild.Command<IndexAndUploadCommand>(),
        ],
    };

    protected override void InitializeServices(IServiceCollection serviceCollection)
    {
        base.InitializeServices(serviceCollection);
        serviceCollection.AddSingleton<ExtensionServices>();
    }
}
