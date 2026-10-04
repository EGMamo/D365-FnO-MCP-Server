using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace D365FnoMcp.Core;

/// <summary>
/// Adds or replaces the extension-owned loopback gateway entry and preserves
/// every other top-level key, MCP server and input. System.Text.Json cannot keep
/// comments, so they survive only while the file needs no change, and in .bak.
/// </summary>
public static class McpJsonFile
{
    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    private static readonly TimeSpan LockTimeout = TimeSpan.FromSeconds(10);

    public static string Merge(string? existingJson, string serverName, Uri gatewayEndpoint, string bearerToken)
    {
        if (!gatewayEndpoint.IsLoopback || gatewayEndpoint.Scheme != Uri.UriSchemeHttp)
        {
            throw new ArgumentException("The Visual Studio MCP gateway must use a loopback HTTP endpoint.", nameof(gatewayEndpoint));
        }

        if (string.IsNullOrWhiteSpace(bearerToken))
        {
            throw new ArgumentException("A gateway bearer token is required.", nameof(bearerToken));
        }

        JsonObject root = string.IsNullOrWhiteSpace(existingJson)
            ? new JsonObject()
            : JsonNode.Parse(existingJson, documentOptions: ReadOptions) as JsonObject
                ?? throw new FormatException("The existing .mcp.json is not a JSON object.");

        JsonObject servers = root["servers"] switch
        {
            null => new JsonObject(),
            JsonObject existing => existing,
            _ => throw new FormatException("The existing .mcp.json has a \"servers\" value that is not a JSON object."),
        };
        var entry = new JsonObject
        {
            ["type"] = "http",
            ["url"] = gatewayEndpoint.ToString(),
            ["headers"] = new JsonObject
            {
                ["Authorization"] = $"Bearer {bearerToken}",
            },
        };

        bool removedInput = RemoveRetiredInput(root["inputs"] as JsonArray, $"{serverName}-api-key");
        if (!removedInput && existingJson is not null && JsonNode.DeepEquals(servers[serverName], entry))
        {
            // Nothing of ours changes: hand back the file as it is, comments and formatting included.
            return existingJson;
        }

        root["servers"] = servers;
        servers[serverName] = entry;

        return root.ToJsonString(WriteOptions) + Environment.NewLine;
    }

    /// <summary>
    /// Merges the gateway entry into <paramref name="path"/>. The read-modify-write runs under a
    /// machine-wide lock for that file, so Visual Studio instances never lose each other's (or the
    /// user's) edits; the file is replaced atomically and left untouched when nothing changes. The
    /// first time the extension changes an existing file, its previous content is kept in .bak;
    /// later writes never replace that backup.
    /// </summary>
    public static void Write(string path, string serverName, Uri gatewayEndpoint, string bearerToken)
    {
        string fullPath = Path.GetFullPath(path);
        using Mutex fileLock = AcquireLock(fullPath);
        try
        {
            string? existing = File.Exists(fullPath) ? File.ReadAllText(fullPath) : null;
            string merged = Merge(existing, serverName, gatewayEndpoint, bearerToken);
            if (existing == merged)
            {
                return;
            }

            if (existing is null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            }
            else if (!File.Exists(fullPath + ".bak"))
            {
                ReplaceAtomically(fullPath + ".bak", RedactOwnedSecrets(existing, serverName));
            }

            ReplaceAtomically(fullPath, merged);
        }
        finally
        {
            fileLock.ReleaseMutex();
        }
    }

    /// <summary>The URL of a server entry in an .mcp.json, or null when there is none or the file cannot be read.</summary>
    public static Uri? ReadServerEndpoint(string path, string serverName)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            JsonNode? root = JsonNode.Parse(File.ReadAllText(path), documentOptions: ReadOptions);
            return root is JsonObject && root["servers"]?[serverName]?["url"] is JsonValue url &&
                   url.TryGetValue(out string? text) && Uri.TryCreate(text, UriKind.Absolute, out Uri? uri)
                ? uri
                : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    public static string UserFilePath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".mcp.json");

    public static string SolutionFilePath(string solutionDirectory) => Path.Combine(solutionDirectory, ".mcp.json");

    private static bool RemoveRetiredInput(JsonArray? inputs, string inputId)
    {
        if (inputs is null)
        {
            return false;
        }

        bool removed = false;
        for (int i = inputs.Count - 1; i >= 0; i--)
        {
            if (inputs[i] is JsonObject input && input["id"] is JsonValue id && id.TryGetValue(out string? value) && value == inputId)
            {
                inputs.RemoveAt(i);
                removed = true;
            }
        }

        return removed;
    }

    /// <summary>A named mutex per file path, shared by every process of this user session.</summary>
    private static Mutex AcquireLock(string fullPath)
    {
        string key = OperatingSystem.IsWindows() ? fullPath.ToUpperInvariant() : fullPath;
        string name = "D365FnoMcp.McpJson." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
        var mutex = new Mutex(initiallyOwned: false, name);
        try
        {
            if (!mutex.WaitOne(LockTimeout))
            {
                throw new IOException($"Timed out waiting for another Visual Studio instance to finish updating {fullPath}.");
            }
        }
        catch (AbandonedMutexException)
        {
            // The previous owner exited mid-write; the file itself is only ever replaced atomically.
        }
        catch
        {
            mutex.Dispose();
            throw;
        }

        return mutex;
    }

    /// <summary>Writes a sibling temporary file and moves it over <paramref name="path"/>, so readers never see half a file.</summary>
    private static void ReplaceAtomically(string path, string contents)
    {
        string temp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temp, contents);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    private static string RedactOwnedSecrets(string json, string serverName)
    {
        try
        {
            JsonObject? root = JsonNode.Parse(json, documentOptions: ReadOptions) as JsonObject;
            JsonObject? headers = root?["servers"]?[serverName]?["headers"] as JsonObject;
            if (headers is null)
            {
                return json;
            }

            if (headers["Authorization"] is not null)
            {
                headers["Authorization"] = "<removed>";
            }

            if (headers["X-API-Key"] is not null)
            {
                headers["X-API-Key"] = "<removed>";
            }

            return root!.ToJsonString(WriteOptions) + Environment.NewLine;
        }
        catch (JsonException)
        {
            return json;
        }
    }
}
