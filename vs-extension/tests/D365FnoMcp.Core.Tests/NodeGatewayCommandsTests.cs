using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class NodeGatewayCommandsTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("d365-node-gateway-commands-").FullName;

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    private void Ship()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(NodeGatewayCommands.BundledEntryPoint(this.root))!);
        File.WriteAllText(NodeGatewayCommands.BundledNode(this.root), string.Empty);
        File.WriteAllText(NodeGatewayCommands.BundledEntryPoint(this.root), string.Empty);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" d365-fno-mcp-server ")]
    public void RunsTheShippedGatewayUnlessTheDeveloperSetACommand(string? configured)
    {
        this.Ship();

        (string command, string source) = NodeGatewayCommands.Resolve(configured, this.root);

        Assert.Equal($"\"{NodeGatewayCommands.BundledNode(this.root)}\" \"{NodeGatewayCommands.BundledEntryPoint(this.root)}\"", command);
        Assert.Contains("shipped", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ACommandTheDeveloperSetWins()
    {
        this.Ship();

        Assert.Equal("node C:\\repo\\dist\\src\\index.js", NodeGatewayCommands.Resolve(" node C:\\repo\\dist\\src\\index.js ", this.root).Command);
    }

    [Fact]
    public void WithoutTheShippedGatewayFallsBackToThePath()
    {
        Assert.Equal(ExtensionSettings.DefaultNodeGatewayCommand, NodeGatewayCommands.Resolve(null, this.root).Command);
        File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(this.root, NodeGatewayCommands.BundleFolder)).FullName, "node.exe"), string.Empty);
        Assert.Equal(ExtensionSettings.DefaultNodeGatewayCommand, NodeGatewayCommands.Resolve(null, this.root).Command);
    }
}
