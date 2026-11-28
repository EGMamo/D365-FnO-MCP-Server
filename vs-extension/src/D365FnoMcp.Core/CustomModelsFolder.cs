namespace D365FnoMcp.Core;

/// <summary>What a custom models folder holds, as <see cref="CustomModelsFolder.Inspect"/> found it.</summary>
/// <param name="Folder">The folder, as given.</param>
/// <param name="IsValid">True when it holds at least one model with AOT XML, so the Node gateway has something to index.</param>
/// <param name="Packages">Packages found, by name.</param>
/// <param name="ModelCount">Models with at least one <c>Ax&lt;Type&gt;</c> folder of XML.</param>
/// <param name="Problem">Why the folder is not valid, or null.</param>
public sealed record CustomModelsFolderReport(
    string Folder,
    bool IsValid,
    IReadOnlyList<string> Packages,
    int ModelCount,
    string? Problem)
{
    /// <summary>One line for a prompt or the Output pane.</summary>
    public string Summary =>
        this.IsValid
            ? $"{this.Packages.Count} package(s) and {this.ModelCount} model(s) with AOT XML: {string.Join(", ", this.Packages.Take(10))}{(this.Packages.Count > 10 ? ", ..." : string.Empty)}."
            : this.Problem ?? "The folder holds no models.";
}

/// <summary>
/// Checks that a folder is laid out as Visual Studio's custom metadata folder:
/// <c>&lt;folder&gt;\&lt;Package&gt;\&lt;Model&gt;\Ax&lt;Type&gt;\*.xml</c>. The folder's own name does not matter
/// (it is often <c>Metadata</c>, but need not be).
/// </summary>
public static class CustomModelsFolder
{
    public static CustomModelsFolderReport Inspect(string folder)
    {
        if (string.IsNullOrWhiteSpace(folder))
        {
            return new(folder, false, [], 0, "No folder was given.");
        }

        if (!Directory.Exists(folder))
        {
            return new(folder, false, [], 0, $"The folder '{folder}' does not exist.");
        }

        var packages = new List<string>();
        int models = 0;
        try
        {
            foreach (string package in Directory.EnumerateDirectories(folder))
            {
                int packageModels = 0;
                foreach (string model in Directory.EnumerateDirectories(package))
                {
                    if (HasAotXml(model))
                    {
                        packageModels++;
                    }
                }

                if (packageModels > 0)
                {
                    packages.Add(Path.GetFileName(package));
                    models += packageModels;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new(folder, false, [], 0, $"The folder '{folder}' could not be read: {ex.Message}");
        }

        packages.Sort(StringComparer.OrdinalIgnoreCase);
        return models > 0
            ? new(folder, true, packages, models, null)
            : new(
                folder,
                false,
                [],
                0,
                $"'{folder}' holds no <Package>\\<Model>\\Ax<Type>\\*.xml files. Choose the folder that holds your package folders " +
                "(\"Folder for your own custom metadata\" in Manage local XPP configurations), not a package or model folder.");
    }

    /// <summary>True when the two paths name the same folder, ignoring case, separators and a trailing slash.</summary>
    public static bool SameFolder(string? a, string? b)
    {
        if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b))
        {
            return false;
        }

        static string Normal(string path) =>
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(path.Trim().Trim('"')).Replace('\\', Path.DirectorySeparatorChar));
        return string.Equals(Normal(a), Normal(b), StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasAotXml(string model) =>
        Directory.EnumerateDirectories(model, "Ax*").Any(type => Directory.EnumerateFiles(type, "*.xml").Any());
}
