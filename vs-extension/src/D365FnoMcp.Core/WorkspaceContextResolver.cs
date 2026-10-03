using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace D365FnoMcp.Core;

/// <summary>Resolves context that can be established safely without loading Microsoft F&amp;O CLR types.</summary>
public static partial class WorkspaceContextResolver
{
    public static WorkspaceContext Resolve(string? solutionDirectory, string? sdkVersion)
    {
        if (string.IsNullOrWhiteSpace(solutionDirectory) || !Directory.Exists(solutionDirectory))
        {
            return new WorkspaceContext(sdkVersion, Solution: null, Project: null, Model: null);
        }

        string? solutionFile = Directory.EnumerateFiles(solutionDirectory, "*.sln")
            .Concat(Directory.EnumerateFiles(solutionDirectory, "*.slnx"))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        string solution = solutionFile is null
            ? Path.GetFileName(Path.TrimEndingDirectorySeparator(solutionDirectory))
            : Path.GetFileNameWithoutExtension(solutionFile);

        IReadOnlyList<string> projects = solutionFile is null
            ? FindTopLevelProjects(solutionDirectory)
            : FindSolutionProjects(solutionFile, solutionDirectory);
        if (projects.Count != 1)
        {
            return new WorkspaceContext(sdkVersion, solution, Project: null, Model: null);
        }

        string projectPath = projects[0];
        return new WorkspaceContext(
            sdkVersion,
            solution,
            Path.GetFileNameWithoutExtension(projectPath),
            ReadModel(projectPath));
    }

    private static IReadOnlyList<string> FindSolutionProjects(string solutionFile, string solutionDirectory)
    {
        try
        {
            if (Path.GetExtension(solutionFile).Equals(".slnx", StringComparison.OrdinalIgnoreCase))
            {
                XDocument document = XDocument.Load(solutionFile, LoadOptions.None);
                return document.Descendants()
                    .Select(element => (string?)element.Attribute("Path"))
                    .Where(path => path?.EndsWith(".rnrproj", StringComparison.OrdinalIgnoreCase) == true)
                    .Select(path => Path.GetFullPath(path!, solutionDirectory))
                    .Where(File.Exists)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }

            return File.ReadLines(solutionFile)
                .Select(line => RnrProjectPath().Match(line))
                .Where(match => match.Success)
                .Select(match => Path.GetFullPath(match.Groups["path"].Value.Replace('\\', Path.DirectorySeparatorChar), solutionDirectory))
                .Where(File.Exists)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return Array.Empty<string>();
        }
    }

    private static IReadOnlyList<string> FindTopLevelProjects(string solutionDirectory)
    {
        try
        {
            return Directory.EnumerateFiles(solutionDirectory, "*.rnrproj", SearchOption.TopDirectoryOnly)
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Array.Empty<string>();
        }
    }

    private static string? ReadModel(string projectPath)
    {
        try
        {
            XDocument document = XDocument.Load(projectPath, LoadOptions.None);
            string? model = document.Descendants()
                .FirstOrDefault(element => element.Name.LocalName.Equals("Model", StringComparison.OrdinalIgnoreCase))
                ?.Value
                .Trim();
            return string.IsNullOrWhiteSpace(model) ? null : model;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }

    [GeneratedRegex("\"(?<path>[^\"]+\\.rnrproj)\"", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RnrProjectPath();
}
