using System.Text.Json;
using System.Text.Json.Serialization;

namespace D365FnoMcp.Core;

/// <summary>How the XRef database is signed in to.</summary>
public enum XrefAuthentication
{
    /// <summary>The current Windows user (needs the msnodesqlv8 driver next to the CLI).</summary>
    Windows,
    /// <summary>A SQL login; the password is kept in the secret store.</summary>
    SqlLogin,
}

/// <summary>Everything the extension remembers between sessions. Secrets are never stored here.</summary>
public sealed class ExtensionSettings
{
    /// <summary>Server base URL, e.g. https://app-d365-mcp.azurewebsites.net (no /mcp).</summary>
    public string ServerUrl { get; set; } = string.Empty;

    /// <summary>Name of the server entry written to .mcp.json.</summary>
    public string McpServerName { get; set; } = "d365-fno";

    /// <summary>The CLI: a command on PATH, a path to dist/src/index.js, or a repository folder.</summary>
    public string Cli { get; set; } = "d365-fno-mcp-server";

    /// <summary>Node.js executable used to run the CLI's index.js.</summary>
    public string Node { get; set; } = "node";

    public string PackagesDirectory { get; set; } = string.Empty;

    public string IndexDbPath { get; set; } = DefaultIndexDbPath();

    /// <summary>Delete the index file first instead of updating it incrementally.</summary>
    public bool NewIndex { get; set; }

    public bool ImportXref { get; set; } = true;

    public string XrefServer { get; set; } = "localhost";

    public string XrefDatabase { get; set; } = "DYNAMICSXREFDB";

    public XrefAuthentication XrefAuthentication { get; set; } = XrefAuthentication.Windows;

    public string XrefUser { get; set; } = string.Empty;

    /// <summary>Accept the SQL Server's certificate without validation (typical for a local dev SQL Server).</summary>
    public bool XrefTrustServerCertificate { get; set; } = true;

    /// <summary>ODBC driver used with Windows authentication.</summary>
    public string XrefOdbcDriver { get; set; } = "ODBC Driver 17 for SQL Server";

    public UploadCompression Compression { get; set; } = UploadCompression.Gzip;

    public CompressionLevel CompressionLevel { get; set; } = CompressionLevel.Balanced;

    public bool UseChunks { get; set; } = true;

    public int ChunkSizeMb { get; set; } = 32;

    public int ParallelUploads { get; set; } = 4;

    /// <summary>Strip the packages folder from indexed paths in the uploaded copy.</summary>
    public bool RelativePaths { get; set; } = true;

    public static string DefaultIndexDbPath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D365FnoMcp", "index", "d365_index.db");
}

public enum UploadCompression
{
    Gzip,
    Brotli,
    None,
}

public enum CompressionLevel
{
    Fastest,
    Balanced,
    Smallest,
}

/// <summary>Reads and writes <see cref="ExtensionSettings"/> as JSON.</summary>
public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public SettingsStore(string path)
    {
        this.Path = path;
    }

    public string Path { get; }

    public static string DefaultPath() =>
        System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "D365FnoMcp", "settings.json");

    public ExtensionSettings Load()
    {
        try
        {
            return File.Exists(this.Path)
                ? JsonSerializer.Deserialize<ExtensionSettings>(File.ReadAllText(this.Path), Options) ?? new ExtensionSettings()
                : new ExtensionSettings();
        }
        catch (JsonException)
        {
            // A damaged settings file only costs the user their remembered choices.
            return new ExtensionSettings();
        }
    }

    public void Save(ExtensionSettings settings)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(this.Path)!);
        string temp = this.Path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(settings, Options));
        File.Move(temp, this.Path, overwrite: true);
    }
}

/// <summary>Keeps the API key and SQL password out of files (Windows Credential Manager in Visual Studio).</summary>
public interface ISecretStore
{
    string? Read(string name);

    void Write(string name, string secret);

    void Delete(string name);
}

public static class SecretNames
{
    /// <summary>API key for a server, one entry per server URL.</summary>
    public static string ApiKey(string serverUrl) => $"D365FnoMcp:api-key:{ServerUrl.Normalize(serverUrl)}";

    public static string XrefPassword(string server, string database, string user) =>
        $"D365FnoMcp:xref:{server.Trim().ToLowerInvariant()}/{database.Trim().ToLowerInvariant()}/{user.Trim().ToLowerInvariant()}";
}
