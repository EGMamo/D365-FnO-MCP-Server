using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public sealed class BuildLogsTests : IDisposable
{
    private const string Log = """
        <?xml version="1.0"?>
        <Diagnostics><Items>
          <Diagnostic><DiagnosticType>Compile</DiagnosticType><Severity>Error</Severity><Moniker>ClassNotFound</Moniker>
            <Path>dynamics://Class/MyClass/Method/run</Path><Message>The name 'Foo' does not denote a class.</Message><Line>12</Line><Column>5</Column></Diagnostic>
          <Diagnostic><Moniker>BPUpgradeCodeToday</Moniker><Severity>Warning</Severity>
            <Path>dynamics://Table/OtherTable</Path><Message>Use DateTimeUtil</Message></Diagnostic>
          <Diagnostic Severity="Error" Path="dynamics://Class/MyClass/Method/run" Line="12" Column="5" Message="The name 'Foo' does not denote a class." />
        </Items></Diagnostics>
        """;

    private readonly string root = Directory.CreateTempSubdirectory("d365-build-logs-").FullName;

    public BuildLogsTests()
    {
        this.CustomDir = Path.Combine(this.root, "Custom");
        this.PackageDir = Path.Combine(this.CustomDir, "MyPackage");
        Directory.CreateDirectory(Path.Combine(this.PackageDir, "My Model", "AxClass"));
        Directory.CreateDirectory(Path.Combine(this.CustomDir, "OtherPackage", "Other Model"));
        this.ProjectPath = Path.Combine(this.root, "Solution", "MyProject.rnrproj");
        Directory.CreateDirectory(Path.GetDirectoryName(this.ProjectPath)!);
        File.WriteAllText(this.ProjectPath, """
            <Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
              <PropertyGroup><Model>My Model</Model></PropertyGroup>
              <ItemGroup><Content Include="AxClass\MyClass" /></ItemGroup>
            </Project>
            """);
    }

    private string CustomDir { get; }

    private string PackageDir { get; }

    private string ProjectPath { get; }

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    [Fact]
    public void ParsesElementsAndAttributesAndSplitsPaths()
    {
        IReadOnlyList<BuildDiagnostic> diagnostics = BuildLogs.Parse(Log, Path.Combine("logs", "Dynamics.AX.MyPackage.xppc.err.xml"));

        Assert.Equal(3, diagnostics.Count);
        Assert.Equal(new BuildDiagnostic("Error", "ClassNotFound", "dynamics://Class/MyClass/Method/run", "Class", "MyClass", "run", 12, 5,
            "The name 'Foo' does not denote a class.", "Dynamics.AX.MyPackage.xppc.err.xml"), diagnostics[0]);
        Assert.Equal(("Table", "OtherTable", ""), (diagnostics[1].ElementType, diagnostics[1].ElementName, diagnostics[1].Method));
        Assert.True(diagnostics[2].IsError);
        Assert.Equal(12, diagnostics[2].Line);
        Assert.Empty(BuildLogs.Parse("not xml", "x.xml"));
        Assert.Equal(("Class", "", ""), BuildLogs.ParsePath("dynamics://Class"));
    }

    [Fact]
    public void FindsOnlyNewLogsOutsideMetadataFolders()
    {
        DateTime started = DateTime.UtcNow.AddMinutes(-1);
        string fresh = this.WriteLog("BuildModelResult.xml");
        string nested = this.WriteLog(Path.Combine("bin", "Dynamics.AX.MyPackage.xppbp.xml"));
        string old = this.WriteLog("Dynamics.AX.MyPackage.labelc.xml");
        File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddHours(-1));
        this.WriteLog(Path.Combine("My Model", "AxClass", "Dynamics.AX.Hidden.xppc.xml"));
        this.WriteLog("Descriptor.xml");

        Assert.Equal(new[] { fresh, nested }.Order(StringComparer.OrdinalIgnoreCase), BuildLogs.Find([this.PackageDir, Path.Combine(this.root, "missing")], started));
        Assert.Equal(new[] { this.PackageDir }, BuildLogs.PackageFolders(this.CustomDir, "my model"));
        Assert.Empty(BuildLogs.PackageFolders(null, "My Model"));
    }

    [Fact]
    public async Task GatewayBuildsThenReportsDiagnosticsFromTheLogsOfThatBuild()
    {
        File.SetLastWriteTimeUtc(this.WriteLog("BuildModelResult.xml", "<Diagnostics><Diagnostic><Severity>Error</Severity><Message>stale</Message></Diagnostic></Diagnostics>"), DateTime.UtcNow.AddHours(-1));
        var projects = new Projects(this.ProjectPath, () => this.WriteLog(Path.Combine("bin", "Dynamics.AX.MyPackage.xppc.err.xml")));

        JsonNode data = await this.BuildAsync(projects);

        Assert.Equal(1, projects.Builds);
        Assert.Equal("MyProject", (string?)data["project"]);
        Assert.False((bool)data["succeeded"]!);
        Assert.Equal(1, (int)data["errors"]!);
        Assert.Equal(1, (int)data["warnings"]!);
        Assert.Equal(new[] { "Dynamics.AX.MyPackage.xppc.err.xml" }, data["logs"]!.AsArray().Select(log => (string?)log));
        JsonNode first = data["diagnostics"]![0]!;
        Assert.Equal("Error", (string?)first["severity"]);
        Assert.Equal("run", (string?)first["method"]);
        Assert.True((bool)first["inProject"]!);
        Assert.False((bool)data["diagnostics"]![1]!["inProject"]!);
        Assert.Null(data["note"]);
    }

    [Fact]
    public async Task GatewaySaysWhenTheBuildWroteNoLog()
    {
        JsonNode data = await this.BuildAsync(new Projects(this.ProjectPath, () => { }));

        Assert.Null(data["succeeded"]);
        Assert.Contains("Error List", (string?)data["note"]);
    }

    [Fact]
    public async Task GatewayReportsABuildFailureAsAToolError()
    {
        await using McpGateway gateway = await this.StartAsync(new Projects(this.ProjectPath, () => throw new InvalidOperationException("Solution is closing.")));
        JsonNode result = await CallAsync(gateway, new JsonObject());

        Assert.True((bool)result["isError"]!);
        Assert.Contains("Solution is closing.", (string?)result["content"]![0]!["text"]);
    }

    private string WriteLog(string relativePath, string content = Log)
    {
        string path = Path.Combine(this.PackageDir, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    private async Task<JsonNode> BuildAsync(Projects projects)
    {
        await using McpGateway gateway = await this.StartAsync(projects);
        JsonNode result = await CallAsync(gateway, new JsonObject());
        Assert.False((bool)result["isError"]!);
        return JsonNode.Parse((string)result["content"]![0]!["text"]!)!;
    }

    private async Task<McpGateway> StartAsync(Projects projects)
    {
        var gateway = new McpGateway(new HttpClient(new Upstream()), new Context(), projects) { CustomMetadataDirectory = this.CustomDir };
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
        return gateway;
    }

    private static async Task<JsonNode> CallAsync(McpGateway gateway, JsonObject arguments)
    {
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);
        var request = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 5,
            ["method"] = "tools/call",
            ["params"] = new JsonObject { ["name"] = McpGateway.BuildProjectToolName, ["arguments"] = arguments },
        };
        using HttpResponseMessage response = await client.PostAsync(gateway.Endpoint, new StringContent(request.ToJsonString(), Encoding.UTF8, "application/json"));
        return JsonNode.Parse(await response.Content.ReadAsStringAsync())!["result"]!;
    }

    /// <summary>Stands in for Visual Studio: a build runs <paramref name="build"/>, which writes logs or throws.</summary>
    private sealed class Projects(string projectPath, Action build) : IVisualStudioProjects
    {
        public int Builds { get; private set; }

        public Task<string> FindProjectAsync(string? projectName, CancellationToken cancellationToken) => Task.FromResult(projectPath);

        public Task AddFilesAsync(string project, IReadOnlyList<string> paths, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task BuildAsync(string project, CancellationToken cancellationToken)
        {
            this.Builds++;
            build();
            return Task.CompletedTask;
        }
    }

    private sealed class Context : IWorkspaceContextProvider
    {
        public Task<WorkspaceContext> GetAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new WorkspaceContext(null, null, null, null));
    }

    private sealed class Upstream : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") });
    }
}
