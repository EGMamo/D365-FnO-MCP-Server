namespace D365FnoMcp.Core;

/// <summary>
/// Holds a custom index file for one Visual Studio instance. The Node gateway keeps one index file per XPP
/// configuration so a restart or a switch back is quick, but two instances indexing into one SQLite file
/// would fight over it. The lock is a sibling <c>.lock</c> file opened without sharing; while one instance
/// holds it, another gets null and indexes in memory instead.
/// </summary>
public sealed class IndexFileLock : IDisposable
{
    private readonly FileStream stream;

    private IndexFileLock(string indexPath, FileStream stream)
    {
        this.IndexPath = indexPath;
        this.stream = stream;
    }

    /// <summary>The index file this lock guards.</summary>
    public string IndexPath { get; }

    /// <summary>The index file for a configuration under <paramref name="indexesFolder"/>.</summary>
    public static string PathFor(string indexesFolder, XppConfiguration configuration) =>
        Path.Combine(indexesFolder, XppConfigurations.IndexKey(configuration) + ".db");

    /// <summary>Takes the lock on <paramref name="indexPath"/>, or returns null when another process holds it.</summary>
    public static IndexFileLock? TryAcquire(string indexPath)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(indexPath)!);
            var stream = new FileStream(indexPath + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
            return new IndexFileLock(indexPath, stream);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Dispose() => this.stream.Dispose();
}
