using D365FnoMcp.Core;
using D365FnoMcp.Extension.UI;
using Microsoft.VisualStudio.Extensibility.Shell;
using Microsoft.VisualStudio.RpcContracts.Notifications;

namespace D365FnoMcp.Extension;

/// <summary>Shows the tool picker for a validated connection.</summary>
internal static class ToolPicker
{
    /// <summary>
    /// Returns the allow list to save (null for all tools), or <paramref name="current"/>
    /// unchanged with false when the dialog was cancelled.
    /// </summary>
    public static async Task<(bool Changed, List<string>? Setting)> ChooseAsync(
        ShellExtensibility shell,
        string serverUrl,
        IEnumerable<ToolInfo> hostedTools,
        List<string>? current,
        bool customModelsIndexed,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ToolInfo> available = ToolSelection.Available(hostedTools, customModelsIndexed);
        var data = new ToolSelectionData(serverUrl, available, ToolSelection.ToSet(current));
        using var control = new ToolSelectionControl(data);
        DialogResult result = await shell.ShowDialogAsync(control, "D365 F&O MCP: allowed tools", DialogOption.OKCancel, cancellationToken);
        return result == DialogResult.OK
            ? (true, ToolSelection.ToSetting(available, data.SelectedNames))
            : (false, current);
    }
}
