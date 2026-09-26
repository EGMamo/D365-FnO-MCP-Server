using Microsoft.VisualStudio.Extensibility.UI;

namespace D365FnoMcp.Extension.IndexUpload;

/// <summary>Remote UI control; its XAML is the embedded IndexUploadControl.xaml.</summary>
internal sealed class IndexUploadControl : RemoteUserControl
{
    public IndexUploadControl(IndexUploadViewModel dataContext)
        : base(dataContext)
    {
    }
}
