using System.Text.Json;
using System.Text.Json.Nodes;

namespace D365FnoMcp.Core;

/// <summary>
/// Adds or replaces the extension-owned loopback gateway entry and preserves
/// unrelated MCP servers and inputs.
/// </summary>
public static class McpJsonFile
{
    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

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

        JsonObject servers = root["servers"] as JsonObject ?? new JsonObject();
        root["servers"] = servers;
        RemoveRetiredInput(root["inputs"] as JsonArray, $"{serverName}-api-key");
        servers[serverName] = new JsonObject
        {
            ["type"] = "http",
            ["url"] = gatewayEndpoint.ToString(),
            ["headers"] = new JsonObject
            {
                ["Authorization"] = $"Bearer {bearerToken}",
            },
        };

        return root.ToJsonString(WriteOptions) + Environment.NewLine;
    }

    public static void Write(string path, string serverName, Uri gatewayEndpoint, string bearerToken)
    {
        string? existing = File.Exists(path) ? File.ReadAllText(path) : null;
        string merged = Merge(existing, serverName, gatewayEndpoint, bearerToken);
        if (existing == merged)
        {
            return;
        }

        if (existing is not null)
        {
            File.WriteAllText(path + ".bak", RedactOwnedSecrets(existing, serverName));
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        }

        string temp = path + ".tmp";
        File.WriteAllText(temp, merged);
        File.Move(temp, path, overwrite: true);
    }

    public static string UserFilePath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".mcp.json");

    public static string SolutionFilePath(string solutionDirectory) => Path.Combine(solutionDirectory, ".mcp.json");

    private static void RemoveRetiredInput(JsonArray? inputs, string inputId)
    {
        if (inputs is null)
        {
            return;
        }

        for (int i = inputs.Count - 1; i >= 0; i--)
        {
            if (inputs[i] is JsonObject input && (string?)input["id"] == inputId)
            {
                inputs.RemoveAt(i);
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
