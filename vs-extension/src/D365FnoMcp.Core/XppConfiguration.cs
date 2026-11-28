using System.Text.Json;

namespace D365FnoMcp.Core;

/// <summary>
/// One configuration from Visual Studio's "Manage local XPP configurations" (unified developer
/// experience), stored as <c>%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\&lt;name&gt;__&lt;version&gt;.json</c>.
/// Only the fields the extension uses are read; credentials in the file are never read.
/// </summary>
/// <param name="Name">The configuration's name, e.g. <c>zelesta-dev</c>.</param>
/// <param name="Version">The application version from the file name, e.g. <c>10.0.2790.105</c>, or null.</param>
/// <param name="ModelStoreFolder">"Folder for your own custom metadata": the packages the developer owns.</param>
/// <param name="FrameworkDirectory">The PackagesLocalDirectory of the platform and reference packages.</param>
/// <param name="ReferencePackagesPaths">"Folders for reference metadata".</param>
/// <param name="CrossReferencesDbServerName">Server of the compiler's cross-reference database.</param>
/// <param name="CrossReferencesDatabaseName">Name of the compiler's cross-reference database.</param>
/// <param name="DefaultModelForNewProjects">The model new projects get, used when a project names none.</param>
/// <param name="FilePath">The JSON file it was read from.</param>
/// <param name="LastWriteTimeUtc">When that file was last saved.</param>
public sealed record XppConfiguration(
    string Name,
    string? Version,
    string? ModelStoreFolder,
    string? FrameworkDirectory,
    IReadOnlyList<string> ReferencePackagesPaths,
    string? CrossReferencesDbServerName,
    string? CrossReferencesDatabaseName,
    string? DefaultModelForNewProjects,
    string FilePath,
    DateTime LastWriteTimeUtc);

/// <summary>Which configuration the extension follows, and why, for the Output pane.</summary>
/// <param name="Configuration">The configuration, or null when none could be used.</param>
/// <param name="Reason">One sentence saying how it was chosen, or why none was.</param>
public sealed record XppConfigurationChoice(XppConfiguration? Configuration, string Reason);

/// <summary>Reads Visual Studio's XPP configurations and picks the one the extension follows.</summary>
public static class XppConfigurations
{
    /// <summary>Separates the configuration name from the version in the file name.</summary>
    private const string NameVersionSeparator = "__";

    /// <summary>The folder Visual Studio keeps the configurations in.</summary>
    public static string Folder(string localAppData) => Path.Combine(localAppData, "Microsoft", "Dynamics365", "XPPConfig");

    /// <summary>The folder for this user, from <c>%LOCALAPPDATA%</c>.</summary>
    public static string DefaultFolder() =>
        Folder(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));

    /// <summary>Every configuration in <paramref name="folder"/> that can be read, ordered by name. Broken files are skipped.</summary>
    public static IReadOnlyList<XppConfiguration> List(string folder)
    {
        if (!Directory.Exists(folder))
        {
            return [];
        }

        var found = new List<XppConfiguration>();
        foreach (string file in Directory.EnumerateFiles(folder, "*.json"))
        {
            XppConfiguration? configuration = TryRead(file);
            if (configuration is not null)
            {
                found.Add(configuration);
            }
        }

        return found.OrderBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>Reads one configuration file; null when it is missing or is not a configuration.</summary>
    public static XppConfiguration? TryRead(string file)
    {
        try
        {
            using FileStream stream = File.OpenRead(file);
            using JsonDocument document = JsonDocument.Parse(stream, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            (string name, string? version) = SplitFileName(Path.GetFileNameWithoutExtension(file));
            string? modelStore = String(root, "ModelStoreFolder") ?? String(root, "DebugSourceFolder");
            string? framework = String(root, "FrameworkDirectory");
            if (modelStore is null && framework is null)
            {
                // Not an XPP configuration (another tool's JSON in the same folder).
                return null;
            }

            var references = new List<string>();
            if (root.TryGetProperty("ReferencePackagesPaths", out JsonElement paths) && paths.ValueKind == JsonValueKind.Array)
            {
                references.AddRange(paths.EnumerateArray()
                    .Where(p => p.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(p.GetString()))
                    .Select(p => p.GetString()!));
            }

            return new XppConfiguration(
                name,
                version ?? PackagesDirectoryLocator.SdkVersion(framework),
                modelStore,
                framework,
                references,
                String(root, "CrossReferencesDbServerName"),
                String(root, "CrossReferencesDatabaseName"),
                String(root, "DefaultModelForNewProjects"),
                file,
                File.GetLastWriteTimeUtc(file));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Picks the configuration to follow: the one the developer pinned, else the only one, else the most
    /// recently saved. The files carry no "Current" flag, but ticking Current in Manage local XPP
    /// configurations saves that configuration's file, so the newest is normally the Current one.
    /// </summary>
    public static XppConfigurationChoice Choose(IReadOnlyList<XppConfiguration> configurations, string? pinnedName)
    {
        if (!string.IsNullOrWhiteSpace(pinnedName))
        {
            XppConfiguration? pinned = configurations.FirstOrDefault(c => c.Name.Equals(pinnedName.Trim(), StringComparison.OrdinalIgnoreCase));
            return pinned is not null
                ? new(pinned, $"XPP configuration '{pinned.Name}' (selected in Extensions > D365 F&O MCP > Select XPP Configuration...).")
                : new(null, $"The selected XPP configuration '{pinnedName.Trim()}' no longer exists; select another one (Extensions > D365 F&O MCP > Select XPP Configuration...).");
        }

        return configurations.Count switch
        {
            0 => new(null, "No XPP configuration was found (Manage local XPP configurations in the Dynamics 365 menu creates one)."),
            1 => new(configurations[0], $"XPP configuration '{configurations[0].Name}' (the only one on this machine)."),
            _ => Newest(configurations),
        };
    }

    /// <summary>Choose over the configurations in this user's folder.</summary>
    public static XppConfigurationChoice ChooseDefault(string? pinnedName) => Choose(List(DefaultFolder()), pinnedName);

    /// <summary>A file-name-safe key for a configuration, used to keep one custom index per configuration.</summary>
    public static string IndexKey(XppConfiguration configuration)
    {
        string raw = configuration.Version is null ? configuration.Name : $"{configuration.Name}__{configuration.Version}";
        char[] invalid = Path.GetInvalidFileNameChars();
        return new string(raw.Select(c => invalid.Contains(c) || char.IsWhiteSpace(c) ? '_' : c).ToArray());
    }

    internal static (string Name, string? Version) SplitFileName(string fileName)
    {
        int separator = fileName.LastIndexOf(NameVersionSeparator, StringComparison.Ordinal);
        if (separator > 0)
        {
            string version = fileName[(separator + NameVersionSeparator.Length)..];
            if (Version.TryParse(version, out _))
            {
                return (fileName[..separator], version);
            }
        }

        return (fileName, null);
    }

    private static XppConfigurationChoice Newest(IReadOnlyList<XppConfiguration> configurations)
    {
        XppConfiguration newest = configurations.OrderByDescending(c => c.LastWriteTimeUtc).First();
        return new(
            newest,
            $"XPP configuration '{newest.Name}', the most recently saved of {configurations.Count} (ticking Current saves it). If Visual Studio's Current configuration is another one, " +
            "select it in Extensions > D365 F&O MCP > Select XPP Configuration....");
    }

    private static string? String(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!.Trim()
            : null;
}
