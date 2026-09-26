using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class McpJsonFileTests
{
    [Fact]
    public void NewFileUsesAPromptedKey()
    {
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(null, "d365-fno", "https://app.example.net/", McpJsonTarget.SolutionPromptForKey, "secret-key"))!;

        Assert.Equal("http", (string?)root["servers"]!["d365-fno"]!["type"]);
        Assert.Equal("https://app.example.net/mcp", (string?)root["servers"]!["d365-fno"]!["url"]);
        Assert.Equal("${input:d365-fno-api-key}", (string?)root["servers"]!["d365-fno"]!["headers"]!["X-API-Key"]);
        JsonNode input = root["inputs"]!.AsArray().Single()!;
        Assert.Equal("d365-fno-api-key", (string?)input["id"]);
        Assert.True((bool)input["password"]!);
        Assert.DoesNotContain("secret-key", root.ToJsonString());
    }

    [Fact]
    public void KeepsOtherServersInputsAndToleratesComments()
    {
        const string existing = """
            {
              // shared by the team
              "inputs": [ { "id": "other", "type": "promptString" } ],
              "servers": {
                "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
                "d365-fno": { "type": "http", "url": "https://old.example.net/mcp" },
              },
            }
            """;
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(existing, "d365-fno", "https://new.example.net/mcp", McpJsonTarget.UserPromptForKey))!;

        Assert.Equal("https://api.githubcopilot.com/mcp/", (string?)root["servers"]!["github"]!["url"]);
        Assert.Equal("https://new.example.net/mcp", (string?)root["servers"]!["d365-fno"]!["url"]);
        Assert.Equal(new[] { "other", "d365-fno-api-key" }, root["inputs"]!.AsArray().Select(i => (string?)i!["id"]));
    }

    [Fact]
    public void KeyInFileReplacesThePromptedInput()
    {
        string prompted = McpJsonFile.Merge(null, "d365-fno", "https://app.example.net", McpJsonTarget.UserPromptForKey);
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(prompted, "d365-fno", "https://app.example.net", McpJsonTarget.UserKeyInFile, "secret-key"))!;

        Assert.Equal("secret-key", (string?)root["servers"]!["d365-fno"]!["headers"]!["X-API-Key"]);
        Assert.Null(root["inputs"]);
        Assert.Throws<ArgumentException>(() => McpJsonFile.Merge(null, "d365-fno", "https://app.example.net", McpJsonTarget.UserKeyInFile, null));
    }

    [Fact]
    public void RejectsANonObjectFile()
    {
        Assert.Throws<FormatException>(() => McpJsonFile.Merge("[]", "d365-fno", "https://app.example.net", McpJsonTarget.UserPromptForKey));
    }

    [Fact]
    public void WriteKeepsABackupOfAChangedFile()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            string path = Path.Combine(dir, "sub", ".mcp.json");
            McpJsonFile.Write(path, "d365-fno", "https://a.example.net", McpJsonTarget.UserPromptForKey);
            Assert.False(File.Exists(path + ".bak"));
            McpJsonFile.Write(path, "d365-fno", "https://a.example.net", McpJsonTarget.UserPromptForKey);
            Assert.False(File.Exists(path + ".bak"));

            McpJsonFile.Write(path, "d365-fno", "https://b.example.net", McpJsonTarget.UserPromptForKey);
            Assert.Contains("https://a.example.net/mcp", File.ReadAllText(path + ".bak"));
            Assert.Contains("https://b.example.net/mcp", File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
