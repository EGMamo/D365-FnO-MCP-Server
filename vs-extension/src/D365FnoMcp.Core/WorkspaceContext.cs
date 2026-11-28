namespace D365FnoMcp.Core;

/// <summary>Privacy-safe local context exposed by the Visual Studio gateway.</summary>
/// <param name="XppConfiguration">Name of the XPP configuration the extension follows (never its paths), or null.</param>
public sealed record WorkspaceContext(
    string? D365SdkVersion,
    string? Solution,
    string? Project,
    string? Model,
    string? XppConfiguration = null);

public interface IWorkspaceContextProvider
{
    Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken);
}
