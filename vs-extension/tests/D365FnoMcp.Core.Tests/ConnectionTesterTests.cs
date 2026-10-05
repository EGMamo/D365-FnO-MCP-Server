using System.Net;
using System.Text;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class ConnectionTesterTests
{
    private const string Key = "the-key";

    private sealed class FakeServer : HttpMessageHandler
    {
        public bool Healthy { get; init; } = true;

        public bool SseReplies { get; init; }

        public List<string> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string path = request.RequestUri!.AbsolutePath;
            string body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
            this.Requests.Add($"{request.Method} {path} {body}");
            if (path == "/health")
            {
                return this.Healthy ? Json("""{"status":"ok","version":"0.2.0"}""") : new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            }

            string? key = request.Headers.TryGetValues("X-API-Key", out IEnumerable<string>? values) ? values.Single() : null;
            if (key != Key)
            {
                return new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("""{"error":"Unauthorized"}""") };
            }

            if (path == "/mcp" && request.Method == HttpMethod.Post)
            {
                if (body.Contains("\"initialize\""))
                {
                    HttpResponseMessage response = this.Reply("""{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"d365-fno-mcp-server","version":"0.2.0"}}}""");
                    response.Headers.Add("Mcp-Session-Id", "session-1");
                    return response;
                }

                if (body.Contains("notifications/initialized"))
                {
                    return new HttpResponseMessage(HttpStatusCode.Accepted);
                }

                Assert.Equal("session-1", request.Headers.GetValues("Mcp-Session-Id").Single());
                return this.Reply("""{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"},{"name":"b"},{"name":"c"}]}}""");
            }

            if (path == "/mcp" && request.Method == HttpMethod.Delete)
            {
                return new HttpResponseMessage(HttpStatusCode.OK);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        private HttpResponseMessage Reply(string json) => this.SseReplies
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent($"event: message\ndata: {json}\n\n", Encoding.UTF8, "text/event-stream") }
            : Json(json);

        private static HttpResponseMessage Json(string json) =>
            new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    private static Task<ConnectionReport> Test(FakeServer server, string key = Key) =>
        new ConnectionTester(new HttpClient(server)).TestAsync("https://app.example.net/mcp", key, CancellationToken.None);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReportsAHealthyServer(bool sse)
    {
        var server = new FakeServer { SseReplies = sse };
        ConnectionReport report = await Test(server);

        Assert.True(report.Succeeded, report.Summary());
        Assert.Equal(3, report.ToolCount);
        Assert.Equal(new[] { "a", "b", "c" }, report.Tools.Select(tool => tool.Name));
        // The MCP session opened for the test is closed again.
        Assert.Contains(server.Requests, r => r.StartsWith("DELETE /mcp", StringComparison.Ordinal));
    }

    [Fact]
    public async Task StopsAtAnUnhealthyServer()
    {
        ConnectionReport report = await Test(new FakeServer { Healthy = false });
        Assert.False(report.Succeeded);
        Assert.Single(report.Checks);
        Assert.Contains("HTTP 503", report.Summary());
    }

    [Fact]
    public async Task ReportsARejectedKey()
    {
        ConnectionReport report = await Test(new FakeServer(), "wrong");
        Assert.False(report.Succeeded);
        Assert.Contains("rejected the API key", report.Summary());
    }

    [Fact]
    public async Task RefusesPlainHttpToARemoteHostWithoutSendingTheKey()
    {
        var server = new FakeServer();
        ConnectionReport report = await new ConnectionTester(new HttpClient(server)).TestAsync("http://app.example.net", Key, CancellationToken.None);

        Assert.False(report.Succeeded);
        Assert.Contains("https", report.Summary());
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task AllowsPlainHttpToLoopback()
    {
        ConnectionReport report = await new ConnectionTester(new HttpClient(new FakeServer())).TestAsync("http://localhost:3000", Key, CancellationToken.None);
        Assert.True(report.Succeeded, report.Summary());
    }

    [Fact]
    public void ParsesTheResponseEventFromAStream()
    {
        const string stream = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{}}\r\n\r\n";
        Assert.Equal(7, (int)ConnectionTester.ParseRpcBody(stream, "text/event-stream")!["id"]!);
    }
}
