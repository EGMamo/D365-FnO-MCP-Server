using System.Runtime.Serialization;
using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility.UI;

namespace D365FnoMcp.Extension.UI;

/// <summary>Data context of the tool picker dialog.</summary>
[DataContract]
internal sealed class ToolSelectionData : NotifyPropertyChangedObject
{
    public ToolSelectionData(string serverUrl, IEnumerable<ToolInfo> tools, IReadOnlySet<string>? allowed)
    {
        this.Heading = $"Tools that Copilot may use from {serverUrl}. Unchecked tools are hidden from Visual Studio and refused by the local gateway.";
        foreach (ToolInfo tool in tools)
        {
            this.Tools.Add(new ToolChoice(tool.Name, tool.Description, ToolSelection.IsAllowed(allowed, tool.Name)));
        }

        this.SelectAllCommand = new AsyncCommand((_, _) => this.SetAllAsync(true));
        this.SelectNoneCommand = new AsyncCommand((_, _) => this.SetAllAsync(false));
    }

    [DataMember]
    public string Heading { get; }

    [DataMember]
    public ObservableList<ToolChoice> Tools { get; } = new();

    [DataMember]
    public IAsyncCommand SelectAllCommand { get; }

    [DataMember]
    public IAsyncCommand SelectNoneCommand { get; }

    public IEnumerable<string> SelectedNames => this.Tools.Where(tool => tool.IsSelected).Select(tool => tool.Name);

    private Task SetAllAsync(bool selected)
    {
        foreach (ToolChoice tool in this.Tools)
        {
            tool.IsSelected = selected;
        }

        return Task.CompletedTask;
    }
}

[DataContract]
internal sealed class ToolChoice : NotifyPropertyChangedObject
{
    private bool isSelected;

    public ToolChoice(string name, string description, bool isSelected)
    {
        this.Name = name;
        this.Description = description;
        this.isSelected = isSelected;
    }

    [DataMember]
    public string Name { get; }

    [DataMember]
    public string Description { get; }

    [DataMember]
    public bool IsSelected
    {
        get => this.isSelected;
        set => this.SetProperty(ref this.isSelected, value);
    }
}
