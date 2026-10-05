using System.Net.Http.Headers;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace D365FnoMcp.Core;

/// <summary>
/// Loopback-only MCP gateway. It forwards one downstream session to the hosted
/// service and adds local tools without disclosing the hosted API key.
/// </summary>
public sealed class McpGateway : IAsyncDisposable
{
    public const string ContextToolName = "workspace_get_context";

    public const string ContextToolDescription = "Returns privacy-safe D365 F&O context for the current Visual Studio workspace. Local paths and credentials are never returned.";

    /// <summary>Marks the gateway's own 401, so another Visual Studio instance can tell a live gateway from a reused port.</summary>
    private const string GatewayHeader = "X-D365FnoMcp-Gateway";
    private readonly HttpClient upstreamClient;
    private readonly IWorkspaceContextProvider contextProvider;
    private WebApplication? application;
    private string upstreamEndpoint = string.Empty;
    private string apiKey = string.Empty;
    private string? sdkVersion;
    private volatile IReadOnlySet<string>? allowedTools;

    public McpGateway(HttpClient upstreamClient, IWorkspaceContextProvider contextProvider)
    {
        this.upstreamClient = upstreamClient;
        this.contextProvider = contextProvider;
    }

    public Uri? Endpoint { get; private set; }

    public string BearerToken { get; private set; } = string.Empty;

    /// <summary>
    /// Tools offered to Visual Studio; null offers all of them. Others are left out of
    /// tools/list and refused on tools/call. Takes effect on the next request.
    /// </summary>
    public IReadOnlySet<string>? AllowedTools
    {
        get => this.allowedTools;
        set => this.allowedTools = value;
    }

    public async Task StartAsync(string serverUrl, string apiKey, string? sdkVersion, CancellationToken cancellationToken)
    {
        if (this.application is not null)
        {
            return;
        }

        this.upstreamEndpoint = ServerUrl.McpEndpoint(serverUrl);
        this.apiKey = string.IsNullOrWhiteSpace(apiKey) ? throw new ArgumentException("An upstream API key is required.", nameof(apiKey)) : apiKey;
        this.sdkVersion = sdkVersion;
        this.BearerToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

        WebApplicationBuilder builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        WebApplication app = builder.Build();
        app.MapMethods("/mcp", ["POST", "GET", "DELETE"], this.HandleAsync);
        await app.StartAsync(cancellationToken);

        string address = app.Urls.Single(url => url.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) ||
                                                url.StartsWith("http://localhost:", StringComparison.Ordinal));
        this.Endpoint = new Uri(new Uri(address), "/mcp");
        this.application = app;
    }

    /// <summary>
    /// True when <paramref name="endpoint"/> is a loopback gateway that is still running,
    /// typically one started by another Visual Studio instance.
    /// </summary>
    public static async Task<bool> IsRunningAtAsync(HttpClient http, Uri endpoint, CancellationToken cancellationToken)
    {
        if (!endpoint.IsLoopback || endpoint.Scheme != Uri.UriSchemeHttp)
        {
            return false;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            using HttpResponseMessage response = await http.GetAsync(endpoint, timeout.Token);
            return response.StatusCode == HttpStatusCode.Unauthorized && response.Headers.Contains(GatewayHeader);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (this.application is null)
        {
            return;
        }

        await this.application.StopAsync();
        await this.application.DisposeAsync();
        this.application = null;
    }

    private async Task HandleAsync(HttpContext context)
    {
        string authorization = context.Request.Headers.Authorization.ToString();
        if (!authorization.Equals($"Bearer {this.BearerToken}", StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            context.Response.Headers[GatewayHeader] = "1";
            return;
        }

        if (!HttpMethods.IsPost(context.Request.Method))
        {
            await this.ProxyAsync(context, body: null);
            return;
        }

        using var reader = new StreamReader(context.Request.Body, Encoding.UTF8);
        string body = await reader.ReadToEndAsync(context.RequestAborted);
        JsonNode? request;
        try
        {
            request = JsonNode.Parse(body);
        }
        catch (System.Text.Json.JsonException)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        string? method = (string?)request?["method"];
        string? calledTool = method == "tools/call" ? (string?)request?["params"]?["name"] : null;
        if (calledTool is not null && !ToolSelection.IsAllowed(this.allowedTools, calledTool))
        {
            await WriteErrorAsync(context, request?["id"], -32602, $"Tool '{calledTool}' is turned off in the D365 F&O MCP extension (Extensions > D365 F&O MCP > Select Tools...).");
            return;
        }

        if (calledTool == ContextToolName)
        {
            await this.WriteContextResultAsync(context, request?["id"]);
            return;
        }

        await this.ProxyAsync(
            context,
            body,
            appendContextTool: method == "tools/list",
            appendContextInstructions: method == "initialize");
    }

    private async Task ProxyAsync(
        HttpContext context,
        string? body,
        bool appendContextTool = false,
        bool appendContextInstructions = false)
    {
        using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), this.upstreamEndpoint);
        if (body is not null)
        {
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }

        request.Headers.Add("X-API-Key", this.apiKey);
        if (!string.IsNullOrWhiteSpace(this.sdkVersion))
        {
            request.Headers.Add("X-D365-Client-Sdk-Version", this.sdkVersion);
        }

        CopyHeader(context.Request.Headers, request, "Accept");
        CopyHeader(context.Request.Headers, request, "Mcp-Session-Id");
        CopyHeader(context.Request.Headers, request, "Mcp-Protocol-Version");

        using HttpResponseMessage response = await this.upstreamClient.SendAsync(
            request,
            appendContextTool || appendContextInstructions
                ? HttpCompletionOption.ResponseContentRead
                : HttpCompletionOption.ResponseHeadersRead,
            context.RequestAborted);
        context.Response.StatusCode = (int)response.StatusCode;
        if (response.Headers.TryGetValues("Mcp-Session-Id", out IEnumerable<string>? sessions))
        {
            context.Response.Headers["Mcp-Session-Id"] = sessions.ToArray();
        }

        if (!appendContextTool && !appendContextInstructions)
        {
            context.Response.ContentType = response.Content.Headers.ContentType?.ToString();
            await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
            return;
        }

        string responseText = await response.Content.ReadAsStringAsync(context.RequestAborted);
        JsonNode? responseBody = ConnectionTester.ParseRpcBody(responseText, response.Content.Headers.ContentType?.MediaType);
        if (responseBody?["result"]?["tools"] is JsonArray tools)
        {
            IReadOnlySet<string>? allowed = this.allowedTools;
            for (int i = tools.Count - 1; i >= 0; i--)
            {
                string? name = (string?)tools[i]?["name"];
                if (name == ContextToolName || name is null || !ToolSelection.IsAllowed(allowed, name))
                {
                    tools.RemoveAt(i);
                }
            }

            if (ToolSelection.IsAllowed(allowed, ContextToolName))
            {
                tools.Add(ContextTool());
            }
        }

        if (appendContextInstructions && responseBody?["result"] is JsonObject initializeResult)
        {
            WorkspaceContext workspace = await this.contextProvider.GetAsync(context.RequestAborted);
            string hosted = (string?)initializeResult["instructions"] ?? string.Empty;
            string local =
                $"Visual Studio workspace context: SDK {workspace.D365SdkVersion ?? "unknown"}; " +
                $"solution {workspace.Solution ?? "unknown"}; project {workspace.Project ?? "ambiguous or unknown"}; " +
                $"model {workspace.Model ?? "ambiguous or unknown"}. Use {ContextToolName} to refresh this local context.";
            initializeResult["instructions"] = string.IsNullOrWhiteSpace(hosted) ? local : $"{hosted}{Environment.NewLine}{Environment.NewLine}{local}";
        }

        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(responseBody?.ToJsonString() ?? responseText, context.RequestAborted);
    }

    private async Task WriteContextResultAsync(HttpContext context, JsonNode? id)
    {
        WorkspaceContext workspace = await this.contextProvider.GetAsync(context.RequestAborted);
        var data = new JsonObject
        {
            ["d365SdkVersion"] = workspace.D365SdkVersion,
            ["solution"] = workspace.Solution,
            ["project"] = workspace.Project,
            ["model"] = workspace.Model,
        };
        var response = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id?.DeepClone(),
            ["result"] = new JsonObject
            {
                ["content"] = new JsonArray(new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = data.ToJsonString(),
                }),
                ["structuredContent"] = data.DeepClone(),
            },
        };
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(response.ToJsonString(), context.RequestAborted);
    }

    private static async Task WriteErrorAsync(HttpContext context, JsonNode? id, int code, string message)
    {
        var response = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id?.DeepClone(),
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
        };
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(response.ToJsonString(), context.RequestAborted);
    }

    private static JsonObject ContextTool() => new()
    {
        ["name"] = ContextToolName,
        ["description"] = ContextToolDescription,
        ["inputSchema"] = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject(),
            ["additionalProperties"] = false,
        },
        ["outputSchema"] = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["d365SdkVersion"] = NullableStringSchema(),
                ["solution"] = NullableStringSchema(),
                ["project"] = NullableStringSchema(),
                ["model"] = NullableStringSchema(),
            },
            ["required"] = new JsonArray("d365SdkVersion", "solution", "project", "model"),
        },
    };

    private static JsonObject NullableStringSchema() => new()
    {
        ["type"] = new JsonArray("string", "null"),
    };

    private static void CopyHeader(IHeaderDictionary source, HttpRequestMessage target, string name)
    {
        if (source.TryGetValue(name, out Microsoft.Extensions.Primitives.StringValues values))
        {
            target.Headers.TryAddWithoutValidation(name, values.ToArray());
        }
    }
}
