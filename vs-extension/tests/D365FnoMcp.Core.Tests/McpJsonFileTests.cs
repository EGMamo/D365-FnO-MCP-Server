using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class McpJsonFileTests
{
    private static readonly Uri GatewayA = new("http://127.0.0.1:45123/mcp");
    private static readonly Uri GatewayB = new("http://localhost:45124/mcp");

    [Fact]
    public void NewFilePointsOnlyToTheLoopbackGateway()
    {
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(null, "d365-fno", GatewayA, "local-token"))!;

        Assert.Equal("http", (string?)root["servers"]!["d365-fno"]!["type"]);
        Assert.Equal(GatewayA.ToString(), (string?)root["servers"]!["d365-fno"]!["url"]);
        Assert.Equal("Bearer local-token", (string?)root["servers"]!["d365-fno"]!["headers"]!["Authorization"]);
        Assert.Null(root["inputs"]);
        Assert.DoesNotContain("X-API-Key", root.ToJsonString());
    }

    [Fact]
    public void KeepsUnrelatedServersAndInputsAndRemovesTheRetiredKeyInput()
    {
        const string existing = """
            {
              // shared by the team
              "inputs": [
                { "id": "other", "type": "promptString" },
                { "id": "d365-fno-api-key", "type": "promptString" },
              ],
              "servers": {
                "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
                "d365-fno": { "type": "http", "url": "https://old.example.net/mcp" },
              },
            }
            """;
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(existing, "d365-fno", GatewayA, "token"))!;

        Assert.Equal("https://api.githubcopilot.com/mcp/", (string?)root["servers"]!["github"]!["url"]);
        Assert.Equal(GatewayA.ToString(), (string?)root["servers"]!["d365-fno"]!["url"]);
        Assert.Equal(new[] { "other" }, root["inputs"]!.AsArray().Select(input => (string?)input!["id"]));
    }

    [Theory]
    [InlineData("https://127.0.0.1:45123/mcp")]
    [InlineData("http://app.example.net/mcp")]
    public void RejectsNonLoopbackHttpEndpoints(string endpoint) =>
        Assert.Throws<ArgumentException>(() => McpJsonFile.Merge(null, "d365-fno", new Uri(endpoint), "token"));

    [Fact]
    public void RejectsANonObjectFile() =>
        Assert.Throws<FormatException>(() => McpJsonFile.Merge("[]", "d365-fno", GatewayA, "token"));

    [Fact]
    public void ChangedFileBackupRedactsThePreviousGatewayToken()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            string path = Path.Combine(dir, "sub", ".mcp.json");
            McpJsonFile.Write(path, "d365-fno", GatewayA, "secret-token-a");
            Assert.False(File.Exists(path + ".bak"));

            McpJsonFile.Write(path, "d365-fno", GatewayB, "secret-token-b");

            Assert.DoesNotContain("secret-token-a", File.ReadAllText(path + ".bak"));
            Assert.Contains("removed", File.ReadAllText(path + ".bak"));
            Assert.Contains("secret-token-b", File.ReadAllText(path));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
