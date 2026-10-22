namespace D365FnoMcp.Core;

/// <summary>A tool offered through the gateway, as shown in the tool picker.</summary>
public sealed record ToolInfo(string Name, string Description);

/// <summary>
/// Which tools the gateway offers to Visual Studio. The setting is an allow list;
/// null means every tool, including tools the server adds later.
/// </summary>
public static class ToolSelection
{
    public static bool IsAllowed(IReadOnlySet<string>? allowed, string name) => allowed is null || allowed.Contains(name);

    /// <summary>The Node gateway's own tool, offered when the extension runs it for a custom models folder.</summary>
    public static readonly ToolInfo LocalIndexStatusTool = new(
        "local_index_status",
        "Reports the custom models index on this machine: object counts, refresh state and hosted server reachability.");

    /// <summary>Hosted tools plus the gateway's own local tools, sorted by name.</summary>
    public static IReadOnlyList<ToolInfo> Available(IEnumerable<ToolInfo> hostedTools, bool customModelsIndexed = false)
    {
        var byName = new Dictionary<string, ToolInfo>(StringComparer.Ordinal);
        foreach (ToolInfo tool in hostedTools)
        {
            byName[tool.Name] = tool;
        }

        if (customModelsIndexed)
        {
            byName[LocalIndexStatusTool.Name] = LocalIndexStatusTool;
        }

        byName[McpGateway.ContextToolName] = new(McpGateway.ContextToolName, McpGateway.ContextToolDescription);
        byName[McpGateway.AddToProjectToolName] = new(McpGateway.AddToProjectToolName, McpGateway.AddToProjectToolDescription);
        return byName.Values.OrderBy(tool => tool.Name, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// The setting to save for a selection: null when every available tool is selected,
    /// otherwise the selected names in order.
    /// </summary>
    public static List<string>? ToSetting(IEnumerable<ToolInfo> available, IEnumerable<string> selected)
    {
        var chosen = new HashSet<string>(selected, StringComparer.Ordinal);
        return available.All(tool => chosen.Contains(tool.Name))
            ? null
            : chosen.OrderBy(name => name, StringComparer.Ordinal).ToList();
    }

    public static IReadOnlySet<string>? ToSet(IEnumerable<string>? setting) =>
        setting is null ? null : new HashSet<string>(setting, StringComparer.Ordinal);

    /// <summary>One line for the picker: the first line of the description, shortened.</summary>
    public static string ShortDescription(string? description)
    {
        string line = (description ?? string.Empty).Trim().Split('\n')[0].Trim();
        return line.Length <= 160 ? line : line[..157] + "...";
    }
}
