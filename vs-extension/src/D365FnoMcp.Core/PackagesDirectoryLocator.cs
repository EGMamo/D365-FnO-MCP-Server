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
                .OrderByDescending(dir => Path.GetFileName(dir), StringComparer.OrdinalIgnoreCase)
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
}
