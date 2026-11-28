namespace D365FnoMcp.Core;

/// <summary>How the extension runs the Node gateway: its own copy from the VSIX, or a command the developer set.</summary>
public static class NodeGatewayCommands
{
    /// <summary>The folder in the extension's install directory that holds the shipped Node gateway.</summary>
    public const string BundleFolder = "node-gateway";

    /// <summary>Node.js for Windows, shipped next to the gateway.</summary>
    public static string BundledNode(string extensionDirectory) => Path.Combine(extensionDirectory, BundleFolder, "node.exe");

    /// <summary>The entry point of the shipped developer package, whose <c>gateway</c> command starts the gateway.</summary>
    public static string BundledEntryPoint(string extensionDirectory) =>
        Path.Combine(extensionDirectory, BundleFolder, "app", "src", "clientIndex.js");

    /// <summary>
    /// The command to run, and where it comes from. A command the developer set (anything but the default) wins;
    /// otherwise the shipped Node.js and gateway, when the VSIX has them; otherwise the default command on the PATH.
    /// </summary>
    public static (string Command, string Source) Resolve(string? configured, string extensionDirectory)
    {
        string? trimmed = configured?.Trim();
        if (!string.IsNullOrEmpty(trimmed) && !trimmed.Equals(ExtensionSettings.DefaultNodeGatewayCommand, StringComparison.OrdinalIgnoreCase))
        {
            return (trimmed, "NodeGatewayCommand in settings.json");
        }

        string node = BundledNode(extensionDirectory);
        string entryPoint = BundledEntryPoint(extensionDirectory);
        if (File.Exists(node) && File.Exists(entryPoint))
        {
            return ($"\"{node}\" \"{entryPoint}\"", "the Node.js and gateway shipped with the extension");
        }

        return (ExtensionSettings.DefaultNodeGatewayCommand, "the d365-fno-mcp-server command on the PATH");
    }
}
