using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace D365FnoMcp.Core;

/// <summary>A saved metadata file checked against the project it should join.</summary>
/// <param name="Path">The full path the caller gave.</param>
/// <param name="ProjectItem">The project's Content item, e.g. AxClass\MyClass; null when the path is not an AOT file.</param>
/// <param name="AlreadyInProject">True when the project file already lists the item.</param>
/// <param name="Issue">Why the file cannot be added; null when it can.</param>
public sealed record ProjectFileCheck(string Path, string? ProjectItem, bool AlreadyInProject, string? Issue)
{
    public bool CanAdd => this.Issue is null && !this.AlreadyInProject;
}

/// <summary>
/// Checks files that an agent saved under the custom metadata folder before Visual Studio adds them
/// to a Finance and Operations project. Reads only; the project system makes the change.
/// </summary>
public static partial class ProjectFiles
{
    /// <summary>The project's model and the AOT items it lists, read from the .rnrproj on disk.</summary>
    public static (string? Model, IReadOnlySet<string> Items) ReadProject(string projectPath)
    {
        XDocument document = XDocument.Load(projectPath, LoadOptions.None);
        string? model = document.Descendants()
            .FirstOrDefault(element => element.Name.LocalName.Equals("Model", StringComparison.OrdinalIgnoreCase))
            ?.Value
            .Trim();
        var items = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (XElement content in document.Descendants().Where(element => element.Name.LocalName == "Content"))
        {
            string? include = (string?)content.Attribute("Include");
            if (!string.IsNullOrWhiteSpace(include))
            {
                items.Add(include.Replace('/', '\\'));
            }
        }

        return (string.IsNullOrWhiteSpace(model) ? null : model, items);
    }

    /// <summary>
    /// Checks each path: an existing <c>&lt;Package&gt;\&lt;Model&gt;\Ax*\&lt;Name&gt;.xml</c> file of the project's model,
    /// inside <paramref name="customMetadataDirectory"/> when one is set.
    /// </summary>
    public static IReadOnlyList<ProjectFileCheck> Check(string projectPath, IEnumerable<string> paths, string? customMetadataDirectory)
    {
        (string? model, IReadOnlySet<string> items) = ReadProject(projectPath);
        string? root = string.IsNullOrWhiteSpace(customMetadataDirectory)
            ? null
            : Path.TrimEndingDirectorySeparator(Path.GetFullPath(customMetadataDirectory));
        return paths.Select(path => CheckOne(path, model, items, root)).ToList();
    }

    private static ProjectFileCheck CheckOne(string path, string? model, IReadOnlySet<string> items, string? root)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
        {
            return new(path, null, false, "Give the file's full path, as returned in the generated file's target.");
        }

        string full = Path.GetFullPath(path);
        string name = Path.GetFileNameWithoutExtension(full);
        string? folder = Path.GetDirectoryName(full);
        string aotType = folder is null ? string.Empty : Path.GetFileName(folder);
        string? modelFolder = folder is null ? null : Path.GetDirectoryName(folder);
        if (!Path.GetExtension(full).Equals(".xml", StringComparison.OrdinalIgnoreCase) || !AotType().IsMatch(aotType) || !ElementName().IsMatch(name))
        {
            return new(path, null, false, "Not an AOT metadata file: expected <Package>\\<Model>\\Ax<Type>\\<Name>.xml.");
        }

        string projectItem = $"{aotType}\\{name}";
        if (root is not null && !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return new(path, projectItem, false, "The file is outside the custom models folder set in the extension.");
        }

        if (model is null)
        {
            return new(path, projectItem, false, "The project does not name its model.");
        }

        if (modelFolder is null || !Path.GetFileName(modelFolder).Equals(model, StringComparison.OrdinalIgnoreCase))
        {
            return new(path, projectItem, false, $"The file is not in the folder of the project's model '{model}'.");
        }

        if (!File.Exists(full))
        {
            return new(path, projectItem, false, "The file does not exist; save it first.");
        }

        return new(path, projectItem, items.Contains(projectItem), null);
    }

    [GeneratedRegex("^Ax[A-Za-z]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AotType();

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_.]*$", RegexOptions.CultureInvariant)]
    private static partial Regex ElementName();
}

/// <summary>The open Finance and Operations projects, changed and built through Visual Studio's project system.</summary>
public interface IVisualStudioProjects
{
    /// <summary>
    /// The full path of the open Finance and Operations project: the one named, or the solution's only one.
    /// Throws <see cref="InvalidOperationException"/> with a message for the user when none or several match.
    /// </summary>
    Task<string> FindProjectAsync(string? projectName, CancellationToken cancellationToken);

    /// <summary>Adds the files to the project and saves it, so the project needs no reload.</summary>
    Task AddFilesAsync(string projectPath, IReadOnlyList<string> paths, CancellationToken cancellationToken);

    /// <summary>Builds the project as Visual Studio's Build command does; completes when the build has finished.</summary>
    Task BuildAsync(string projectPath, CancellationToken cancellationToken);
}
