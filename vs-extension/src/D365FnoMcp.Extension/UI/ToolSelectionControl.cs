using Microsoft.VisualStudio.Extensibility.UI;

namespace D365FnoMcp.Extension.UI;

/// <summary>Checkbox list of tools; the layout is in ToolSelectionControl.xaml.</summary>
internal sealed class ToolSelectionControl : RemoteUserControl
{
    public ToolSelectionControl(ToolSelectionData data)
        : base(data)
    {
    }
}
