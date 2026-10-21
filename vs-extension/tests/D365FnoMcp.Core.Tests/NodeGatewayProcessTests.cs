using System.Diagnostics;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

[Collection(NodeGatewayCollection.Name)]
public class NodeGatewayProcessTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("d365-node-gateway-").FullName;

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    private NodeGatewayOptions Options(string command) => new(
        command,
        "https://app.example.net",
        "hosted-secret-key-0123456789abcdef0123456789",
        Directory.CreateDirectory(Path.Combine(this.root, "custom")).FullName,
        "Contoso, Fabrikam",
        Path.Combine(this.root, "work"));

    [Fact]
    public void PassesTheKeyAndTokenInTheEnvironmentOnly()
    {
        NodeGatewayOptions options = this.Options("d365-fno-mcp-server");
        ProcessStartInfo info = NodeGatewayProcess.BuildStartInfo(options, 52011, "token-value", windows: false);

        Assert.Equal("/bin/sh", info.FileName);
        Assert.Equal(["-c", "exec d365-fno-mcp-server gateway"], info.ArgumentList);
        Assert.DoesNotContain("hosted-secret", string.Join(' ', info.ArgumentList) + info.Arguments);
        Assert.DoesNotContain("token-value", string.Join(' ', info.ArgumentList) + info.Arguments);
        Assert.Equal("https://app.example.net/mcp", info.Environment["D365_HOSTED_MCP_URL"]);
        Assert.Equal(options.ApiKey, info.Environment["D365_HOSTED_API_KEY"]);
        Assert.Equal(string.Empty, info.Environment["D365_HOSTED_API_KEY_FILE"]);
        Assert.Equal(options.CustomMetadataDirectory, info.Environment["D365_CUSTOM_METADATA_DIR"]);
        Assert.Equal(":memory:", info.Environment["D365_LOCAL_INDEX_DB_PATH"]);
        Assert.Equal("52011", info.Environment["D365_GATEWAY_PORT"]);
        Assert.Equal("token-value", info.Environment["D365_GATEWAY_TOKEN"]);
        Assert.Equal("Contoso, Fabrikam", info.Environment["D365_GATEWAY_PRIVATE_PREFIXES"]);
        Assert.Equal(string.Empty, info.Environment["D365_GATEWAY_STANDARD_INDEX_DB_PATH"]);
        Assert.Equal(options.WorkingDirectory, info.WorkingDirectory);
        Assert.False(info.UseShellExecute);
    }

    [Fact]
    public void PassesTheStandardIndex()
    {
        string file = Path.Combine(this.root, "d365_index.db");
        ProcessStartInfo info = NodeGatewayProcess.BuildStartInfo(this.Options("d365-fno-mcp-server") with { StandardIndexPath = $" {file} " }, 52011, "token-value", windows: false);

        Assert.Equal(file, info.Environment["D365_GATEWAY_STANDARD_INDEX_DB_PATH"]);
    }

    [Fact]
    public async Task RejectsAMissingStandardIndex()
    {
        await using var gateway = new NodeGatewayProcess(new HttpClient(), _ => { });
        NodeGatewayOptions options = this.Options("d365-fno-mcp-server") with { StandardIndexPath = Path.Combine(this.root, "missing.db") };

        await Assert.ThrowsAsync<FileNotFoundException>(() => gateway.StartAsync(options, CancellationToken.None));
    }

    [Fact]
    public void RunsTheCommandThroughCmdOnWindows()
    {
        ProcessStartInfo info = NodeGatewayProcess.BuildStartInfo(
            this.Options("\"C:\\Program Files\\nodejs\\node.exe\" C:\\tools\\d365\\dist\\src\\index.js"),
            52011,
            "token-value",
            windows: true);

        Assert.Equal("cmd.exe", info.FileName);
        Assert.Equal("/d /s /c \"\"C:\\Program Files\\nodejs\\node.exe\" C:\\tools\\d365\\dist\\src\\index.js gateway\"", info.Arguments);
    }

    [Fact]
    public async Task RejectsAMissingCustomFolder()
    {
        await using var gateway = new NodeGatewayProcess(new HttpClient(), _ => { });
        NodeGatewayOptions options = this.Options("d365-fno-mcp-server") with { CustomMetadataDirectory = Path.Combine(this.root, "missing") };

        await Assert.ThrowsAsync<DirectoryNotFoundException>(() => gateway.StartAsync(options, CancellationToken.None));
    }

    [Fact]
    public async Task StartsOnceHealthAnswersAndStopsOnDispose()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // Stands in for the Node gateway: records its environment, then serves /health.
        string site = Directory.CreateDirectory(Path.Combine(this.root, "site")).FullName;
        File.WriteAllText(Path.Combine(site, "health"), "ok");
        string envFile = Path.Combine(this.root, "env.txt");
        string script = Path.Combine(this.root, "fake-gateway.sh");
        File.WriteAllText(
            script,
            $"#!/bin/sh\nprintf '%s|%s|%s' \"$1\" \"$D365_GATEWAY_TOKEN\" \"$D365_CUSTOM_METADATA_DIR\" > '{envFile}'\n" +
            $"echo listening\nexec python3 -m http.server \"$D365_GATEWAY_PORT\" --bind 127.0.0.1 --directory '{site}'\n");
        var lines = new List<string>();
        var gateway = new NodeGatewayProcess(new HttpClient(), line => { lock (lines) { lines.Add(line); } });

        await gateway.StartAsync(this.Options($"sh '{script}'"), CancellationToken.None, TimeSpan.FromSeconds(30));

        Assert.False(gateway.HasExited);
        Assert.Equal("127.0.0.1", gateway.BaseUrl!.Host);
        Assert.Equal(64, gateway.Token.Length);
        Assert.Equal($"gateway|{gateway.Token}|{Path.Combine(this.root, "custom")}", File.ReadAllText(envFile));
        lock (lines)
        {
            Assert.Contains("[node gateway] listening", lines);
        }

        await gateway.DisposeAsync();
        Assert.True(gateway.HasExited);
        using var client = new HttpClient();
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync(new Uri(gateway.BaseUrl, "/health")));
    }

    [Fact]
    public async Task ReportsAGatewayThatExitsBeforeItIsReady()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        await using var gateway = new NodeGatewayProcess(new HttpClient(), _ => { });
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => gateway.StartAsync(this.Options("sh -c 'exit 3' --"), CancellationToken.None, TimeSpan.FromSeconds(30)));

        Assert.Contains("code 3", error.Message);
        Assert.True(gateway.HasExited);
    }

    [Fact]
    public async Task TimesOutWhenHealthNeverAnswers()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        await using var gateway = new NodeGatewayProcess(new HttpClient(), _ => { });
        await Assert.ThrowsAsync<TimeoutException>(
            () => gateway.StartAsync(this.Options("sleep 30 #"), CancellationToken.None, TimeSpan.FromSeconds(2)));
        Assert.True(gateway.HasExited);
    }
}
