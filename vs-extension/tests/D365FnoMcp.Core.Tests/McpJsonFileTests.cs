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

    [Fact]
    public void KeepsOtherTopLevelKeysAndServerSettings()
    {
        const string existing = """
            {
              "$schema": "https://example.net/mcp.schema.json",
              "sandbox": { "enabled": true },
              "servers": {
                "local": { "type": "stdio", "command": "node", "args": ["server.js"], "env": { "A": "1" } },
                "d365-fno": { "type": "http", "url": "http://127.0.0.1:1/mcp", "headers": { "Authorization": "Bearer old" } }
              }
            }
            """;
        JsonNode root = JsonNode.Parse(McpJsonFile.Merge(existing, "d365-fno", GatewayA, "token"))!;

        Assert.Equal("https://example.net/mcp.schema.json", (string?)root["$schema"]);
        Assert.True((bool)root["sandbox"]!["enabled"]!);
        Assert.True(JsonNode.DeepEquals(
            JsonNode.Parse("""{ "type": "stdio", "command": "node", "args": ["server.js"], "env": { "A": "1" } }"""),
            root["servers"]!["local"]));
        Assert.Equal("Bearer token", (string?)root["servers"]!["d365-fno"]!["headers"]!["Authorization"]);
    }

    [Fact]
    public void ReturnsAnUpToDateFileUnchangedWithItsComments()
    {
        string existing = $$"""
            {
              // team servers
              "servers": {
                "d365-fno": { "type": "http", "url": "{{GatewayA}}", "headers": { "Authorization": "Bearer token" } },
              },
            }
            """;

        Assert.Same(existing, McpJsonFile.Merge(existing, "d365-fno", GatewayA, "token"));
    }

    [Fact]
    public void RejectsServersThatAreNotAnObject() =>
        Assert.Throws<FormatException>(() => McpJsonFile.Merge("""{ "servers": [] }""", "d365-fno", GatewayA, "token"));

    [Fact]
    public void BackupKeepsTheOriginalFileAndIsWrittenOnlyOnce()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            string path = Path.Combine(dir, ".mcp.json");
            const string original = """
                {
                  // mine
                  "servers": { "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" } }
                }
                """;
            File.WriteAllText(path, original);

            McpJsonFile.Write(path, "d365-fno", GatewayA, "token-a");
            Assert.Equal(original, File.ReadAllText(path + ".bak"));
            DateTime written = File.GetLastWriteTimeUtc(path);

            // An unchanged entry leaves the file alone.
            McpJsonFile.Write(path, "d365-fno", GatewayA, "token-a");
            Assert.Equal(written, File.GetLastWriteTimeUtc(path));

            // Later launches replace the entry but never the first backup.
            McpJsonFile.Write(path, "d365-fno", GatewayB, "token-b");
            Assert.Equal(original, File.ReadAllText(path + ".bak"));
            Assert.Contains("token-b", File.ReadAllText(path));
            Assert.Equal("https://api.githubcopilot.com/mcp/", (string?)JsonNode.Parse(File.ReadAllText(path))!["servers"]!["github"]!["url"]);
            Assert.Equal(new[] { ".mcp.json", ".mcp.json.bak" }, Directory.GetFiles(dir).Select(Path.GetFileName).Order());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void ConcurrentWritersDoNotLoseEachOthersEntries()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            string path = Path.Combine(dir, ".mcp.json");
            Parallel.For(0, 16, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i =>
                McpJsonFile.Write(path, $"server-{i}", new Uri($"http://127.0.0.1:{40000 + i}/mcp"), $"token-{i}"));

            JsonObject servers = JsonNode.Parse(File.ReadAllText(path))!["servers"]!.AsObject();
            Assert.Equal(16, servers.Count);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void ReadsTheCurrentServerEndpoint()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            string path = Path.Combine(dir, ".mcp.json");
            Assert.Null(McpJsonFile.ReadServerEndpoint(path, "d365-fno"));

            McpJsonFile.Write(path, "d365-fno", GatewayA, "token");
            Assert.Equal(GatewayA, McpJsonFile.ReadServerEndpoint(path, "d365-fno"));
            Assert.Null(McpJsonFile.ReadServerEndpoint(path, "other"));

            File.WriteAllText(path, "{ damaged");
            Assert.Null(McpJsonFile.ReadServerEndpoint(path, "d365-fno"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
