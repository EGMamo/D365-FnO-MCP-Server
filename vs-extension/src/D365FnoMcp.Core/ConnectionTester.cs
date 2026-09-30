using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace D365FnoMcp.Core;

public enum CheckStatus
{
    Passed,
    Warning,
    Failed,
}

public sealed record ConnectionCheck(string Name, CheckStatus Status, string Detail);

public sealed class ConnectionReport
{
    public List<ConnectionCheck> Checks { get; } = new();

    /// <summary>True when the server answered and accepted the key; warnings are allowed.</summary>
    public bool Succeeded => this.Checks.Count > 0 && this.Checks.All(check => check.Status != CheckStatus.Failed);

    /// <summary>Whether the key may upload indexes (null when the server did not say).</summary>
    public bool? CanUpload { get; set; }

    public int? ToolCount { get; set; }

    public string Summary()
    {
        var builder = new StringBuilder();
        foreach (ConnectionCheck check in this.Checks)
        {
            string mark = check.Status switch
            {
                CheckStatus.Passed => "OK  ",
                CheckStatus.Warning => "WARN",
                _ => "FAIL",
            };
            builder.AppendLine($"{mark} {check.Name}: {check.Detail}");
        }

        return builder.ToString().TrimEnd();
    }
}

/// <summary>
/// Checks a server the way an MCP client would use it: the unauthenticated
/// health endpoint, an MCP initialize + tools/list with the API key, and the
/// admin endpoint that reports the served index and upload permission.
/// </summary>
public sealed class ConnectionTester
{
    private const string ProtocolVersion = "2025-03-26";
    private readonly HttpClient http;

    public ConnectionTester(HttpClient http)
    {
        this.http = http;
    }

    public async Task<ConnectionReport> TestAsync(string serverUrl, string apiKey, CancellationToken cancellationToken)
    {
        var report = new ConnectionReport();
        string baseUrl;
        try
        {
            baseUrl = ServerUrl.Normalize(serverUrl);
        }
        catch (FormatException ex)
        {
            report.Checks.Add(new("URL", CheckStatus.Failed, ex.Message));
            return report;
        }

        if (ServerUrl.IsInsecure(baseUrl))
        {
            report.Checks.Add(new("URL", CheckStatus.Warning, "Plain http to another machine sends the API key unencrypted; use https."));
        }

        if (!await this.CheckHealthAsync(baseUrl, report, cancellationToken))
        {
            return report;
        }

        if (string.IsNullOrEmpty(apiKey))
        {
            report.Checks.Add(new("API key", CheckStatus.Failed, "No API key is configured."));
            return report;
        }

        if (!await this.CheckMcpAsync(baseUrl, apiKey, report, cancellationToken))
        {
            return report;
        }

        await this.CheckIndexAsync(baseUrl, apiKey, report, cancellationToken);
        return report;
    }

    private async Task<bool> CheckHealthAsync(string baseUrl, ConnectionReport report, CancellationToken cancellationToken)
    {
        try
        {
            using HttpResponseMessage response = await this.http.GetAsync($"{baseUrl}/health", cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                report.Checks.Add(new("Health", CheckStatus.Failed, $"{baseUrl}/health answered HTTP {(int)response.StatusCode}. The server may still be downloading its index."));
                return false;
            }

            JsonNode? body = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            report.Checks.Add(new("Health", CheckStatus.Passed, $"server version {(string?)body?["version"] ?? "unknown"}"));
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            report.Checks.Add(new("Health", CheckStatus.Failed, $"Cannot reach {baseUrl}: {ex.Message}"));
            return false;
        }
    }

    private async Task<bool> CheckMcpAsync(string baseUrl, string apiKey, ConnectionReport report, CancellationToken cancellationToken)
    {
        string endpoint = $"{baseUrl}/mcp";
        string? sessionId = null;
        try
        {
            var initialize = new JsonObject
            {
                ["jsonrpc"] = "2.0",
                ["id"] = 1,
                ["method"] = "initialize",
                ["params"] = new JsonObject
                {
                    ["protocolVersion"] = ProtocolVersion,
                    ["capabilities"] = new JsonObject(),
                    ["clientInfo"] = new JsonObject { ["name"] = "d365-fno-mcp-visual-studio", ["version"] = "0.1.0" },
                },
            };
            (HttpStatusCode status, JsonNode? result, sessionId) = await this.PostRpcAsync(endpoint, apiKey, null, initialize, cancellationToken);
            if (status == HttpStatusCode.Unauthorized)
            {
                report.Checks.Add(new("API key", CheckStatus.Failed, "The server rejected the API key (HTTP 401)."));
                return false;
            }

            if (status != HttpStatusCode.OK || result?["result"] is not JsonObject initResult)
            {
                report.Checks.Add(new("MCP", CheckStatus.Failed, $"initialize failed (HTTP {(int)status}): {Describe(result)}"));
                return false;
            }

            string serverName = (string?)initResult["serverInfo"]?["name"] ?? "unknown";
            report.Checks.Add(new("API key", CheckStatus.Passed, "accepted"));

            await this.PostRpcAsync(endpoint, apiKey, sessionId, new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "notifications/initialized" }, cancellationToken);
            (status, result, _) = await this.PostRpcAsync(
                endpoint,
                apiKey,
                sessionId,
                new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 2, ["method"] = "tools/list", ["params"] = new JsonObject() },
                cancellationToken);
            if (result?["result"]?["tools"] is not JsonArray tools)
            {
                report.Checks.Add(new("MCP", CheckStatus.Failed, $"tools/list failed (HTTP {(int)status}): {Describe(result)}"));
                return false;
            }

            report.ToolCount = tools.Count;
            report.Checks.Add(new("MCP", CheckStatus.Passed, $"{serverName} answered initialize and lists {tools.Count} tools"));
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            report.Checks.Add(new("MCP", CheckStatus.Failed, ex.Message));
            return false;
        }
        finally
        {
            if (sessionId is not null)
            {
                using var close = new HttpRequestMessage(HttpMethod.Delete, endpoint);
                close.Headers.Add("X-API-Key", apiKey);
                close.Headers.Add("Mcp-Session-Id", sessionId);
                try
                {
                    using HttpResponseMessage _ = await this.http.SendAsync(close, CancellationToken.None);
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
                {
                    // The server closes idle sessions itself; a timeout here must not replace the report.
                }
            }
        }
    }

    private async Task CheckIndexAsync(string baseUrl, string apiKey, ConnectionReport report, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/admin/index");
            request.Headers.Add("X-API-Key", apiKey);
            using HttpResponseMessage response = await this.http.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                report.Checks.Add(new("Index", CheckStatus.Warning, "This server version does not report its index or accept uploads; update it."));
                return;
            }

            if (!response.IsSuccessStatusCode)
            {
                report.Checks.Add(new("Index", CheckStatus.Warning, $"/admin/index answered HTTP {(int)response.StatusCode}"));
                return;
            }

            JsonNode? body = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            JsonNode? index = body?["index"];
            string source = (string?)index?["source"] ?? "unknown";
            string builtAt = (string?)index?["builtAt"] ?? "unknown";
            long objects = index?["objects"]?.GetValue<long>() ?? 0;
            report.Checks.Add(new("Index", CheckStatus.Passed, $"{objects:N0} objects, built {builtAt} ({source})"));

            bool enabled = body?["upload"]?["enabled"]?.GetValue<bool>() ?? false;
            bool allowed = body?["upload"]?["allowed"]?.GetValue<bool>() ?? false;
            report.CanUpload = enabled && allowed;
            string keyName = (string?)body?["apiKey"] ?? "this key";
            report.Checks.Add(new(
                "Upload",
                CheckStatus.Passed,
                !enabled ? "uploads are disabled on the server" : allowed ? $"key '{keyName}' may upload indexes" : $"key '{keyName}' may not upload (not in D365_INDEX_UPLOAD_KEYS)"));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidOperationException or FormatException)
        {
            report.Checks.Add(new("Index", CheckStatus.Warning, ex.Message));
        }
    }

    private async Task<(HttpStatusCode Status, JsonNode? Body, string? SessionId)> PostRpcAsync(
        string endpoint, string apiKey, string? sessionId, JsonObject message, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(message.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("X-API-Key", apiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        if (sessionId is not null)
        {
            request.Headers.Add("Mcp-Session-Id", sessionId);
            request.Headers.Add("Mcp-Protocol-Version", ProtocolVersion);
        }

        using HttpResponseMessage response = await this.http.SendAsync(request, cancellationToken);
        string? newSession = response.Headers.TryGetValues("Mcp-Session-Id", out IEnumerable<string>? values) ? values.FirstOrDefault() : sessionId;
        string text = await response.Content.ReadAsStringAsync(cancellationToken);
        return (response.StatusCode, ParseRpcBody(text, response.Content.Headers.ContentType?.MediaType), newSession);
    }

    /// <summary>Reads a JSON-RPC reply sent as plain JSON or as a server-sent event stream.</summary>
    internal static JsonNode? ParseRpcBody(string text, string? mediaType)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        if (mediaType == "text/event-stream")
        {
            var data = new StringBuilder();
            foreach (string line in text.Split('\n'))
            {
                string trimmed = line.TrimEnd('\r');
                if (trimmed.StartsWith("data:", StringComparison.Ordinal))
                {
                    data.Append(trimmed[5..].TrimStart());
                }
                else if (trimmed.Length == 0 && data.Length > 0)
                {
                    JsonNode? node = JsonNode.Parse(data.ToString());
                    if (node?["id"] is not null)
                    {
                        return node;
                    }

                    data.Clear();
                }
            }

            return data.Length > 0 ? JsonNode.Parse(data.ToString()) : null;
        }

        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return new JsonObject { ["error"] = text.Length > 300 ? text[..300] : text };
        }
    }

    private static string Describe(JsonNode? body) => body?["error"] switch
    {
        JsonObject error => (string?)error["message"] ?? error.ToJsonString(),
        JsonValue error when error.TryGetValue(out string? message) => message,
        _ => body?.ToJsonString() ?? "no response body",
    };
}
