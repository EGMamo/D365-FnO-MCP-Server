using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class McpGatewayTests
{
    private sealed class ContextProvider : IWorkspaceContextProvider
    {
        public Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new WorkspaceContext("10.0.2095.13", "Sales", "SalesProject", "SalesModel"));
    }

    private sealed class Upstream : HttpMessageHandler
    {
        public int RequestCount { get; private set; }

        public HttpRequestMessage? LastRequest { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            this.RequestCount++;
            this.LastRequest = request;
            string requestBody = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            string responseBody = requestBody.Contains("\"initialize\"", StringComparison.Ordinal)
                ? """{"jsonrpc":"2.0","id":2,"result":{"instructions":"Hosted instructions","serverInfo":{"name":"hosted","version":"1.0.0"}}}"""
                : """{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"metadata_search"}]}}""";
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    responseBody,
                    Encoding.UTF8,
                    "application/json"),
            };
            response.Headers.Add("Mcp-Session-Id", "upstream-session");
            return response;
        }

    }

    /// <summary>Only its presence matters: the gateway lists the project tools when it has a project system.</summary>
    private sealed class Projects : IVisualStudioProjects
    {
        public Task<string> FindProjectAsync(string? projectName, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task AddFilesAsync(string projectPath, IReadOnlyList<string> paths, CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task BuildAsync(string projectPath, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    [Fact]
    public async Task AddsLocalContextToInitializeInstructions()
    {
        var upstream = new Upstream();
        await using var gateway = new McpGateway(new HttpClient(upstream), new ContextProvider());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", "10.0.2095.13", CancellationToken.None);
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);

        using HttpResponseMessage response = await client.PostAsync(
            gateway.Endpoint,
            new StringContent(
                """{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}""",
                Encoding.UTF8,
                "application/json"));
        JsonNode body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        string instructions = (string)body["result"]!["instructions"]!;

        Assert.Contains("Hosted instructions", instructions);
        Assert.Contains("SDK 10.0.2095.13", instructions);
        Assert.Contains("project SalesProject", instructions);
        Assert.Contains("model SalesModel", instructions);
    }

    [Fact]
    public async Task ProxiesHostedToolsAndAddsLocalContext()
    {
        var upstream = new Upstream();
        await using var gateway = new McpGateway(new HttpClient(upstream), new ContextProvider());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", "10.0.2095.13", CancellationToken.None);
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);

        using var request = new StringContent(
            """{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}""",
            Encoding.UTF8,
            "application/json");
        using HttpResponseMessage response = await client.PostAsync(gateway.Endpoint, request);
        JsonNode body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            new[] { "metadata_search", McpGateway.ContextToolName },
            body["result"]!["tools"]!.AsArray().Select(tool => (string?)tool!["name"]));
        Assert.Equal("upstream-secret", upstream.LastRequest!.Headers.GetValues("X-API-Key").Single());
        Assert.Equal("10.0.2095.13", upstream.LastRequest.Headers.GetValues("X-D365-Client-Sdk-Version").Single());
    }

    [Fact]
    public async Task AnnotatesTheThreeLocalTools()
    {
        await using var gateway = new McpGateway(new HttpClient(new Upstream()), new ContextProvider(), new Projects());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);

        using HttpResponseMessage response = await client.PostAsync(
            gateway.Endpoint,
            new StringContent(
                """{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}""",
                Encoding.UTF8,
                "application/json"));
        JsonArray tools = JsonNode.Parse(await response.Content.ReadAsStringAsync())!["result"]!["tools"]!.AsArray();

        // Only the context tool leaves the workspace unchanged; adding to and building the project do not.
        var expectedReadOnly = new Dictionary<string, bool>
        {
            [McpGateway.ContextToolName] = true,
            [McpGateway.AddToProjectToolName] = false,
            [McpGateway.BuildProjectToolName] = false,
        };
        foreach ((string name, bool readOnly) in expectedReadOnly)
        {
            JsonNode? annotations = tools.Single(tool => (string?)tool!["name"] == name)!["annotations"];
            Assert.NotNull(annotations);
            Assert.Equal(readOnly, (bool?)annotations["readOnlyHint"]);
            Assert.False((bool?)annotations["destructiveHint"]);
            Assert.True((bool?)annotations["idempotentHint"]);
            Assert.False((bool?)annotations["openWorldHint"]);
        }
    }

    [Fact]
    public async Task HandlesContextLocallyAndRejectsWrongBearerToken()
    {
        var upstream = new Upstream();
        await using var gateway = new McpGateway(new HttpClient(upstream), new ContextProvider());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);

        using var unauthorized = new HttpClient();
        using HttpResponseMessage rejected = await unauthorized.PostAsync(
            gateway.Endpoint,
            new StringContent("{}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Unauthorized, rejected.StatusCode);

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);
        using HttpResponseMessage response = await client.PostAsync(
            gateway.Endpoint,
            new StringContent(
                """{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"workspace_get_context","arguments":{}}}""",
                Encoding.UTF8,
                "application/json"));
        JsonNode body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;

        Assert.Equal("10.0.2095.13", (string?)body["result"]!["structuredContent"]!["d365SdkVersion"]);
        Assert.Equal("SalesModel", (string?)body["result"]!["structuredContent"]!["model"]);
        Assert.Equal(0, upstream.RequestCount);
    }

    [Fact]
    public async Task RecognizesARunningGatewayOnlyWhileItListens()
    {
        await using var gateway = new McpGateway(new HttpClient(new Upstream()), new ContextProvider());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
        Uri endpoint = gateway.Endpoint!;
        using var http = new HttpClient();

        Assert.True(await McpGateway.IsRunningAtAsync(http, endpoint, CancellationToken.None));

        await gateway.DisposeAsync();
        Assert.False(await McpGateway.IsRunningAtAsync(http, endpoint, CancellationToken.None));
        Assert.False(await McpGateway.IsRunningAtAsync(http, new Uri("https://app.example.net/mcp"), CancellationToken.None));
    }

    [Fact]
    public async Task OffersOnlyAllowedTools()
    {
        var upstream = new Upstream();
        await using var gateway = new McpGateway(new HttpClient(upstream), new ContextProvider());
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);
        async Task<JsonNode> Post(string json)
        {
            using HttpResponseMessage response = await client.PostAsync(gateway.Endpoint, new StringContent(json, Encoding.UTF8, "application/json"));
            return JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        }

        const string list = """{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}""";
        IEnumerable<string?> Names(JsonNode body) => body["result"]!["tools"]!.AsArray().Select(tool => (string?)tool!["name"]);

        gateway.AllowedTools = new HashSet<string> { McpGateway.ContextToolName };
        Assert.Equal(new[] { McpGateway.ContextToolName }, Names(await Post(list)));

        int before = upstream.RequestCount;
        JsonNode refused = await Post("""{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"metadata_search","arguments":{}}}""");
        Assert.Equal(-32602, (int)refused["error"]!["code"]!);
        Assert.Equal(9, (int)refused["id"]!);
        Assert.Equal(before, upstream.RequestCount);

        gateway.AllowedTools = new HashSet<string> { "metadata_search" };
        Assert.Equal(new[] { "metadata_search" }, Names(await Post(list)));
        JsonNode contextRefused = await Post("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workspace_get_context","arguments":{}}}""");
        Assert.NotNull(contextRefused["error"]);

        gateway.AllowedTools = null;
        Assert.Equal(new[] { "metadata_search", McpGateway.ContextToolName }, Names(await Post(list)));
    }

    [Fact]
    public async Task RefusesAPlainHttpRemoteUpstream()
    {
        await using var gateway = new McpGateway(new HttpClient(new Upstream()), new ContextProvider());
        await Assert.ThrowsAsync<FormatException>(() =>
            gateway.StartAsync("http://app.example.net", "upstream-secret", null, CancellationToken.None));
    }
}
