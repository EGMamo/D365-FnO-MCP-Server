using System.Text.Json;
using System.Text.Json.Nodes;

namespace D365FnoMcp.Core;

/// <summary>Where the server entry goes and how the API key reaches Visual Studio.</summary>
public enum McpJsonTarget
{
    /// <summary>&lt;SolutionDir&gt;\.mcp.json, shared through source control; Visual Studio prompts for the key.</summary>
    SolutionPromptForKey,
    /// <summary>%USERPROFILE%\.mcp.json; Visual Studio prompts for the key.</summary>
    UserPromptForKey,
    /// <summary>%USERPROFILE%\.mcp.json with the key written into the header (for clients that drop prompted headers).</summary>
    UserKeyInFile,
}

/// <summary>
/// Adds or replaces one HTTP server entry in a Visual Studio / VS Code style
/// <c>.mcp.json</c> (<c>inputs</c> + <c>servers</c>) and leaves every other entry alone.
/// </summary>
public static class McpJsonFile
{
    private static readonly JsonDocumentOptions ReadOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    public static string InputId(string serverName) => $"{serverName}-api-key";

    /// <summary>Returns the new file content. <paramref name="apiKey"/> is only used for <see cref="McpJsonTarget.UserKeyInFile"/>.</summary>
    public static string Merge(string? existingJson, string serverName, string serverUrl, McpJsonTarget target, string? apiKey = null)
    {
        JsonObject root;
        if (string.IsNullOrWhiteSpace(existingJson))
        {
            root = new JsonObject();
        }
        else
        {
            root = JsonNode.Parse(existingJson, documentOptions: ReadOptions) as JsonObject
                ?? throw new FormatException("The existing .mcp.json is not a JSON object.");
        }

        JsonObject servers = root["servers"] as JsonObject ?? new JsonObject();
        root["servers"] = servers;
        JsonArray inputs = root["inputs"] as JsonArray ?? new JsonArray();
        string inputId = InputId(serverName);

        string keyValue;
        if (target == McpJsonTarget.UserKeyInFile)
        {
            if (string.IsNullOrEmpty(apiKey))
            {
                throw new ArgumentException("An API key is needed to write it into the file.", nameof(apiKey));
            }

            keyValue = apiKey;
            RemoveInput(inputs, inputId);
        }
        else
        {
            keyValue = $"${{input:{inputId}}}";
            RemoveInput(inputs, inputId);
            inputs.Add(new JsonObject
            {
                ["id"] = inputId,
                ["type"] = "promptString",
                ["description"] = $"API key for the {serverName} MCP server",
                ["password"] = true,
            });
        }

        if (inputs.Count > 0)
        {
            root["inputs"] = inputs;
        }
        else
        {
            root.Remove("inputs");
        }

        servers[serverName] = new JsonObject
        {
            ["type"] = "http",
            ["url"] = ServerUrl.McpEndpoint(serverUrl),
            ["headers"] = new JsonObject { ["X-API-Key"] = keyValue },
        };

        return root.ToJsonString(WriteOptions) + Environment.NewLine;
    }

    /// <summary>Writes the merged file, keeping a .bak copy of a file that already existed.</summary>
    public static void Write(string path, string serverName, string serverUrl, McpJsonTarget target, string? apiKey = null)
    {
        string? existing = File.Exists(path) ? File.ReadAllText(path) : null;
        string merged = Merge(existing, serverName, serverUrl, target, apiKey);
        if (existing is not null)
        {
            if (existing == merged)
            {
                return;
            }

            File.Copy(path, path + ".bak", overwrite: true);
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

    private static void RemoveInput(JsonArray inputs, string inputId)
    {
        for (int i = inputs.Count - 1; i >= 0; i--)
        {
            if (inputs[i] is JsonObject input && (string?)input["id"] == inputId)
            {
                inputs.RemoveAt(i);
            }
        }
    }
}
