namespace D365FnoMcp.Core;

/// <summary>Privacy-safe local context exposed by the Visual Studio gateway.</summary>
public sealed record WorkspaceContext(
    string? D365SdkVersion,
    string? Solution,
    string? Project,
    string? Model);

public interface IWorkspaceContextProvider
{
    Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken);
}
