using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

/// <summary>
/// The extension's gateway in front of the real Node gateway. Opt-in: set
/// D365_E2E_NODE_GATEWAY_COMMAND to a command that runs the built server CLI, for example
/// <c>node /repo/dist/src/index.js</c>. The hosted server is unreachable on purpose: custom
/// objects must still be answered from the local index.
/// </summary>
[Collection(NodeGatewayCollection.Name)]
public class NodeGatewayEndToEndTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("d365-node-gateway-e2e-").FullName;

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    private sealed class ContextProvider : IWorkspaceContextProvider
    {
        public Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new WorkspaceContext(null, "Contoso", null, null));
    }

    [Fact]
    public async Task CustomObjectsReachCopilotThroughBothGateways()
    {
        string? command = Environment.GetEnvironmentVariable("D365_E2E_NODE_GATEWAY_COMMAND");
        if (string.IsNullOrWhiteSpace(command))
        {
            return;
        }

        string classDir = Directory.CreateDirectory(Path.Combine(this.root, "custom", "ContosoPkg", "ContosoModel", "AxClass")).FullName;
        File.WriteAllText(
            Path.Combine(classDir, "ContosoLoyaltyService.xml"),
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><AxClass xmlns:i=\"http://www.w3.org/2001/XMLSchema-instance\"><Name>ContosoLoyaltyService</Name>" +
            "<SourceCode><Declaration><![CDATA[\nclass ContosoLoyaltyService\n{\n}\n]]></Declaration><Methods /></SourceCode></AxClass>");

        var log = new List<string>();
        await using var node = new NodeGatewayProcess(new HttpClient(), line => { lock (log) { log.Add(line); } });
        await node.StartAsync(
            new NodeGatewayOptions(
                command,
                $"http://127.0.0.1:{NodeGatewayProcess.FreeLoopbackPort()}",
                "hosted-key-that-is-long-enough-0123456789abcdef",
                Path.Combine(this.root, "custom"),
                "Contoso",
                Path.Combine(this.root, "work")),
            CancellationToken.None,
            TimeSpan.FromMinutes(2));

        await using var gateway = new McpGateway(new HttpClient { Timeout = TimeSpan.FromMinutes(1) }, new ContextProvider());
        await gateway.StartAsync(node.BaseUrl!.ToString(), node.Token, sdkVersion: null, CancellationToken.None);
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", gateway.BearerToken);
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        client.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream");

        (JsonNode initialize, string? session) = await PostAsync(
            client,
            gateway.Endpoint!,
            null,
            """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}""");
        Assert.Contains("Visual Studio workspace context", (string?)initialize["result"]?["instructions"]);
        Assert.NotNull(session);
        await PostAsync(client, gateway.Endpoint!, session, """{"jsonrpc":"2.0","method":"notifications/initialized"}""", expectBody: false);

        (JsonNode list, _) = await PostAsync(client, gateway.Endpoint!, session, """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""");
        string[] names = list["result"]!["tools"]!.AsArray().Select(tool => (string)tool!["name"]!).ToArray();
        Assert.Contains("local_index_status", names);
        Assert.Contains("search_symbols", names);
        Assert.Contains(McpGateway.ContextToolName, names);

        (JsonNode search, _) = await PostAsync(
            client,
            gateway.Endpoint!,
            session,
            """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_symbols","arguments":{"query":"ContosoLoyalty"}}}""");
        string text = search["result"]!["content"]!.AsArray().Select(item => (string?)item!["text"]).Aggregate(string.Empty, (all, part) => all + part);
        Assert.Contains("ContosoLoyaltyService", text);
        Assert.Contains("\"local\"", text);
    }

    private static async Task<(JsonNode Body, string? Session)> PostAsync(HttpClient client, Uri endpoint, string? session, string body, bool expectBody = true)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        if (session is not null)
        {
            request.Headers.Add("Mcp-Session-Id", session);
        }

        using HttpResponseMessage response = await client.SendAsync(request);
        string text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}: {text}");
        string? returnedSession = response.Headers.TryGetValues("Mcp-Session-Id", out IEnumerable<string>? values) ? values.First() : session;
        if (!expectBody)
        {
            return (new JsonObject(), returnedSession);
        }

        JsonNode? parsed = ConnectionTester.ParseRpcBody(text, response.Content.Headers.ContentType?.MediaType);
        Assert.NotNull(parsed);
        return (parsed!, returnedSession);
    }
}
