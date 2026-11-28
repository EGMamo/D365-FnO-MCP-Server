using System.Text.Json;
using System.Text.Json.Serialization;

namespace D365FnoMcp.Core;

/// <summary>Everything the extension remembers between sessions. Secrets are never stored here.</summary>
public sealed class ExtensionSettings
{
    /// <summary>Server base URL, e.g. https://app-d365-mcp.azurewebsites.net (no /mcp).</summary>
    public string ServerUrl { get; set; } = string.Empty;

    /// <summary>Name of the server entry written to .mcp.json.</summary>
    public string McpServerName { get; set; } = "d365-fno";

    /// <summary>The .mcp.json managed by the extension, so its ephemeral gateway entry can be refreshed on startup.</summary>
    public string McpConfigurationPath { get; set; } = string.Empty;

    /// <summary>Tools the gateway offers to Visual Studio; null offers every tool, including ones the server adds later.</summary>
    public List<string>? AllowedTools { get; set; }

    /// <summary>
    /// Folder of the custom models to index on this machine, overriding the XPP configuration's. Empty follows
    /// the custom metadata folder of the XPP configuration the extension follows (see <see cref="XppConfigurationName"/>);
    /// with neither, the gateway forwards to the hosted server only.
    /// </summary>
    public string CustomMetadataDirectory { get; set; } = string.Empty;

    /// <summary>
    /// The XPP configuration (Manage local XPP configurations) to follow, by name. Empty picks it automatically:
    /// the one ticked Current in Visual Studio, else the only one, else the most recently saved.
    /// </summary>
    public string XppConfigurationName { get; set; } = string.Empty;

    /// <summary>
    /// Developer option, off by default: import the compiler's cross-references for the custom models from the XPP
    /// configuration's cross-reference database, so find_usages lists call sites in custom code. Needs the msnodesqlv8
    /// driver and an ODBC driver for SQL Server; the read can hold a compile's writes to that database while it runs.
    /// </summary>
    public bool ImportCrossReferences { get; set; }

    /// <summary>How to run the server's CLI for the Node gateway; "gateway" is appended.</summary>
    public string NodeGatewayCommand { get; set; } = DefaultNodeGatewayCommand;

    /// <summary>Comma-separated prefixes of custom object names that must never be sent to the hosted server.</summary>
    public string PrivatePrefixes { get; set; } = string.Empty;

    /// <summary>
    /// Optional index of the standard application (a d365_index.db built with the server's index command). With
    /// one, the Node gateway lays the custom models over it and answers on this machine the tools it would otherwise
    /// forward, such as security paths and generators; empty forwards those to the hosted server.
    /// </summary>
    public string StandardIndexPath { get; set; } = string.Empty;

    public const string DefaultNodeGatewayCommand = "d365-fno-mcp-server";
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

/// <summary>Keeps the hosted-service API key out of files.</summary>
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

}
