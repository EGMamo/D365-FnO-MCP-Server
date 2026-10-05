using D365FnoMcp.Extension.Commands;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;

namespace D365FnoMcp.Extension;

/// <summary>
/// D365 F&amp;O MCP for Visual Studio: exposes one workspace-aware MCP gateway
/// that combines the hosted D365 metadata service with guarded local tools.
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
            description: "Connects Visual Studio's MCP clients to hosted D365 metadata and guarded local workspace tools through one MCP gateway."),
    };

    [VisualStudioContribution]
    public static MenuConfiguration D365Menu => new("%D365FnoMcp.Menu.DisplayName%")
    {
        Placements = [CommandPlacement.KnownPlacements.ExtensionsMenu],
        Children =
        [
            MenuChild.Command<ConfigureConnectionCommand>(),
            MenuChild.Command<SetApiKeyCommand>(),
            MenuChild.Command<TestConnectionCommand>(),
        ],
    };

    protected override void InitializeServices(IServiceCollection serviceCollection)
    {
        base.InitializeServices(serviceCollection);
        serviceCollection.AddSingleton<ExtensionServices>();
    }
}
