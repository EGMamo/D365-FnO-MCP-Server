using System.Xml;
using System.Xml.Linq;

namespace D365FnoMcp.Core;

/// <summary>One compiler or best-practice message from an X++ build log.</summary>
public sealed record BuildDiagnostic(
    string Severity,
    string Moniker,
    string Path,
    string ElementType,
    string ElementName,
    string Method,
    int? Line,
    int? Column,
    string Message,
    string LogFile)
{
    public bool IsError => this.Severity.Equals("Error", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Reads the XML logs the X++ build writes (xppc, xppbp, labelc, BuildModelResult). Visual Studio's build API
/// reports only that a build finished, so the diagnostics come from the logs written during that build.
/// </summary>
public static class BuildLogs
{
    private const int MaxDepth = 3;

    /// <summary>
    /// XML logs under <paramref name="roots"/> last written at or after <paramref name="sinceUtc"/>. Metadata folders
    /// (Ax*, Descriptor, XppMetadata) are skipped so a large package is not walked.
    /// </summary>
    public static IReadOnlyList<string> Find(IEnumerable<string> roots, DateTime sinceUtc)
    {
        var found = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string root in roots.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Walk(root, 0, sinceUtc, found);
        }

        return found.ToList();
    }

    /// <summary>
    /// The package folders under <paramref name="customMetadataDirectory"/> that hold <paramref name="model"/>,
    /// i.e. each <c>&lt;Package&gt;</c> with a <c>&lt;Package&gt;\&lt;Model&gt;</c> folder.
    /// </summary>
    public static IReadOnlyList<string> PackageFolders(string? customMetadataDirectory, string? model)
    {
        if (string.IsNullOrWhiteSpace(customMetadataDirectory) || string.IsNullOrWhiteSpace(model) || !Directory.Exists(customMetadataDirectory))
        {
            return Array.Empty<string>();
        }

        try
        {
            return Directory.EnumerateDirectories(customMetadataDirectory)
                .Where(package => Directory.EnumerateDirectories(package)
                    .Any(folder => Path.GetFileName(folder).Equals(model, StringComparison.OrdinalIgnoreCase)))
                .OrderBy(package => package, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>Every <c>Diagnostic</c> element, with child elements or attributes matched ignoring case.</summary>
    public static IReadOnlyList<BuildDiagnostic> Parse(string xml, string logFile)
    {
        XDocument document;
        try
        {
            document = XDocument.Parse(xml, LoadOptions.None);
        }
        catch (XmlException)
        {
            return Array.Empty<BuildDiagnostic>();
        }

        var diagnostics = new List<BuildDiagnostic>();
        foreach (XElement node in document.Descendants().Where(element => element.Name.LocalName.Equals("Diagnostic", StringComparison.OrdinalIgnoreCase)))
        {
            string path = Value(node, "Path", "ElementPath");
            string moniker = Value(node, "Moniker", "Rule", "Id");
            string message = Value(node, "Message", "Text");
            if (path.Length == 0 && moniker.Length == 0 && message.Length == 0)
            {
                continue;
            }

            (string elementType, string elementName, string method) = ParsePath(path);
            string severity = Value(node, "Severity", "Level");
            diagnostics.Add(new BuildDiagnostic(
                severity.Length == 0 ? "Unknown" : severity,
                moniker,
                path,
                elementType,
                elementName,
                method,
                Number(Value(node, "Line", "StartLine")),
                Number(Value(node, "Column", "StartColumn", "Col")),
                message,
                Path.GetFileName(logFile)));
        }

        return diagnostics;
    }

    /// <summary>Splits <c>dynamics://Class/MyClass/Method/run</c> into element type, name and method.</summary>
    public static (string ElementType, string ElementName, string Method) ParsePath(string path)
    {
        string[] parts = path.StartsWith("dynamics://", StringComparison.OrdinalIgnoreCase)
            ? path["dynamics://".Length..].Split('/', '\\', StringSplitOptions.RemoveEmptyEntries)
            : path.Split('/', '\\', StringSplitOptions.RemoveEmptyEntries);
        int methodIndex = parts.Length < 3 ? -1 : Array.FindIndex(parts, 2, part => part.Equals("Method", StringComparison.OrdinalIgnoreCase) || part.Equals("Methods", StringComparison.OrdinalIgnoreCase));
        return (
            parts.Length > 0 ? parts[0] : string.Empty,
            parts.Length > 1 ? parts[1] : string.Empty,
            methodIndex >= 0 && methodIndex + 1 < parts.Length ? parts[methodIndex + 1] : string.Empty);
    }

    private static void Walk(string directory, int depth, DateTime sinceUtc, SortedSet<string> found)
    {
        try
        {
            foreach (string file in Directory.EnumerateFiles(directory, "*.xml"))
            {
                if (IsLogName(Path.GetFileName(file)) && File.GetLastWriteTimeUtc(file) >= sinceUtc)
                {
                    found.Add(file);
                }
            }

            if (depth >= MaxDepth)
            {
                return;
            }

            foreach (string child in Directory.EnumerateDirectories(directory))
            {
                string name = Path.GetFileName(child);
                if (!name.StartsWith("Ax", StringComparison.OrdinalIgnoreCase) &&
                    !name.Equals("Descriptor", StringComparison.OrdinalIgnoreCase) &&
                    !name.Equals("XppMetadata", StringComparison.OrdinalIgnoreCase) &&
                    !name.StartsWith('.'))
                {
                    Walk(child, depth + 1, sinceUtc, found);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A folder that cannot be read holds no log we can report.
        }
    }

    private static bool IsLogName(string fileName) =>
        fileName.Equals("BuildModelResult.xml", StringComparison.OrdinalIgnoreCase) ||
        fileName.Contains(".xppc.", StringComparison.OrdinalIgnoreCase) ||
        fileName.Contains(".xppbp.", StringComparison.OrdinalIgnoreCase) ||
        fileName.Contains(".labelc.", StringComparison.OrdinalIgnoreCase);

    private static string Value(XElement node, params string[] names)
    {
        foreach (string name in names)
        {
            XElement? element = node.Elements().FirstOrDefault(child => child.Name.LocalName.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (element is not null)
            {
                return element.Value.Trim();
            }

            XAttribute? attribute = node.Attributes().FirstOrDefault(attr => attr.Name.LocalName.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (attribute is not null)
            {
                return attribute.Value.Trim();
            }
        }

        return string.Empty;
    }

    private static int? Number(string value) => int.TryParse(value, out int number) ? number : null;
}
