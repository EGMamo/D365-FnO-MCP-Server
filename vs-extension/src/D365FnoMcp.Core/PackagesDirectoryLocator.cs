namespace D365FnoMcp.Core;

/// <summary>Finds PackagesLocalDirectory on a unified developer experience machine or a classic dev VM.</summary>
public static class PackagesDirectoryLocator
{
    public static IReadOnlyList<string> Candidates(string localAppData, Func<string, IEnumerable<string>> listDirectories, Func<string, bool> directoryExists)
    {
        var found = new List<string>();

        // Unified developer experience: %LOCALAPPDATA%\Microsoft\Dynamics365\<version>\PackagesLocalDirectory, newest first.
        string ude = Path.Combine(localAppData, "Microsoft", "Dynamics365");
        if (directoryExists(ude))
        {
            found.AddRange(listDirectories(ude)
                .OrderByDescending(dir => Path.GetFileName(dir), VersionFolderComparer.Instance)
                .Select(dir => Path.Combine(dir, "PackagesLocalDirectory"))
                .Where(directoryExists));
        }

        // Classic development VMs.
        foreach (string drive in new[] { "K", "C", "J", "I" })
        {
            string candidate = $@"{drive}:\AosService\PackagesLocalDirectory";
            if (directoryExists(candidate))
            {
                found.Add(candidate);
            }
        }

        return found;
    }

    public static string? Detect() =>
        Candidates(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            dir => Directory.EnumerateDirectories(dir),
            Directory.Exists).FirstOrDefault();

    /// <summary>
    /// The SDK version a PackagesLocalDirectory belongs to: its parent folder name on a unified
    /// developer experience machine (for example 10.0.2095.13). Classic VMs keep it under
    /// AosService, which is not a version, so they report none.
    /// </summary>
    public static string? SdkVersion(string? packagesDirectory)
    {
        string? name = packagesDirectory is null ? null : Path.GetFileName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(packagesDirectory)));
        return name is not null && Version.TryParse(name, out _) ? name : null;
    }

    /// <summary>Orders version folder names numerically (10.0.10000 after 10.0.9999); anything else sorts below, by name.</summary>
    internal sealed class VersionFolderComparer : IComparer<string?>
    {
        public static readonly VersionFolderComparer Instance = new();

        public int Compare(string? x, string? y)
        {
            bool xIsVersion = Version.TryParse(x, out Version? xVersion);
            bool yIsVersion = Version.TryParse(y, out Version? yVersion);
            if (xIsVersion && yIsVersion)
            {
                return xVersion!.CompareTo(yVersion);
            }

            if (xIsVersion != yIsVersion)
            {
                return xIsVersion ? 1 : -1;
            }

            return StringComparer.OrdinalIgnoreCase.Compare(x, y);
        }
    }
}
