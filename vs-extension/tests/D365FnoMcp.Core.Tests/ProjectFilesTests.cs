using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public sealed class ProjectFilesTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("d365-project-files-").FullName;

    public ProjectFilesTests()
    {
        this.CustomDir = Path.Combine(this.root, "Custom");
        this.ModelDir = Path.Combine(this.CustomDir, "MyPackage", "My Model");
        Directory.CreateDirectory(Path.Combine(this.ModelDir, "AxClass"));
        this.ProjectPath = Path.Combine(this.root, "Solution", "MyProject.rnrproj");
        Directory.CreateDirectory(Path.GetDirectoryName(this.ProjectPath)!);
        File.WriteAllText(this.ProjectPath, ProjectXml("""<Content Include="AxClass\ExistingClass"><Name>ExistingClass</Name></Content>"""));
    }

    private string CustomDir { get; }

    private string ModelDir { get; }

    private string ProjectPath { get; }

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    [Fact]
    public void ChecksLayoutModelFolderAndExistingItems()
    {
        string saved = this.Save("AxClass", "MyClass");
        string existing = this.Save("AxClass", "ExistingClass");
        string tableExtension = this.Save("AxTableExtension", "CustTable.MyExt");
        string otherModel = Path.Combine(this.CustomDir, "MyPackage", "Other", "AxClass", "X.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(otherModel)!);
        File.WriteAllText(otherModel, "<AxClass />");
        string outside = Path.Combine(this.root, "Elsewhere", "My Model", "AxClass", "Y.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(outside)!);
        File.WriteAllText(outside, "<AxClass />");

        IReadOnlyList<ProjectFileCheck> checks = ProjectFiles.Check(
            this.ProjectPath,
            [saved, existing, tableExtension, otherModel, outside, Path.Combine(this.ModelDir, "AxClass", "Missing.xml"), "AxClass\\Relative.xml", Path.Combine(this.ModelDir, "Classes", "Z.xml")],
            this.CustomDir);

        Assert.Equal(new ProjectFileCheck(saved, "AxClass\\MyClass", false, null), checks[0]);
        Assert.True(checks[0].CanAdd);
        Assert.True(checks[1].AlreadyInProject);
        Assert.False(checks[1].CanAdd);
        Assert.Equal("AxTableExtension\\CustTable.MyExt", checks[2].ProjectItem);
        Assert.Null(checks[2].Issue);
        Assert.Contains("'My Model'", checks[3].Issue);
        Assert.Contains("outside the custom models folder", checks[4].Issue);
        Assert.Contains("does not exist", checks[5].Issue);
        Assert.Contains("full path", checks[6].Issue);
        Assert.Contains("Not an AOT metadata file", checks[7].Issue);
    }

    [Fact]
    public void WithoutACustomFolderAnyFolderOfTheModelIsAccepted()
    {
        string elsewhere = Path.Combine(this.root, "Elsewhere", "Pkg", "my model", "AxClass", "Y.xml");
        Directory.CreateDirectory(Path.GetDirectoryName(elsewhere)!);
        File.WriteAllText(elsewhere, "<AxClass />");

        Assert.True(ProjectFiles.Check(this.ProjectPath, [elsewhere], customMetadataDirectory: null).Single().CanAdd);
    }

    [Fact]
    public async Task GatewayAddsSavedFilesAndReportsWhatTheProjectNowLists()
    {
        string saved = this.Save("AxClass", "MyClass");
        string existing = this.Save("AxClass", "ExistingClass");
        var adder = new Adder(this.ProjectPath, writesProject: true);
        JsonNode result = await this.CallAsync(adder, new JsonObject { ["paths"] = new JsonArray(saved, existing, "relative.xml") });

        Assert.False((bool)result["isError"]!);
        JsonNode data = JsonNode.Parse((string)result["content"]![0]!["text"]!)!;
        Assert.Equal("MyProject", (string?)data["project"]);
        Assert.Equal(new[] { "added", "alreadyInProject", "skipped" }, data["files"]!.AsArray().Select(file => (string?)file!["status"]));
        Assert.Equal(new[] { Path.GetFullPath(saved) }, adder.Added);
        Assert.Contains("AxClass\\MyClass", ProjectFiles.ReadProject(this.ProjectPath).Items);
    }

    [Fact]
    public async Task GatewaySaysWhenVisualStudioDidNotAddTheItem()
    {
        string saved = this.Save("AxClass", "MyClass");
        JsonNode result = await this.CallAsync(new Adder(this.ProjectPath, writesProject: false), new JsonObject { ["paths"] = new JsonArray(saved) });

        Assert.True((bool)result["isError"]!);
        JsonNode file = JsonNode.Parse((string)result["content"]![0]!["text"]!)!["files"]![0]!;
        Assert.Equal("notAdded", (string?)file["status"]);
        Assert.Contains("Add > Existing Item", (string?)file["issue"]);
    }

    [Fact]
    public async Task GatewayReportsProjectSelectionAndArgumentErrorsAsToolErrors()
    {
        JsonNode noPaths = await this.CallAsync(new Adder(this.ProjectPath, writesProject: true), new JsonObject { ["paths"] = new JsonArray() });
        Assert.True((bool)noPaths["isError"]!);
        Assert.Contains("'paths'", (string?)noPaths["content"]![0]!["text"]);

        JsonNode ambiguous = await this.CallAsync(
            new Adder(this.ProjectPath, writesProject: true) { FindError = "Several projects are open; name one in 'project': A, B." },
            new JsonObject { ["paths"] = new JsonArray(this.Save("AxClass", "MyClass")) });
        Assert.True((bool)ambiguous["isError"]!);
        Assert.Contains("Several projects", (string?)ambiguous["content"]![0]!["text"]);
    }

    [Fact]
    public async Task GatewayListsTheToolOnlyWithAProjectSystemAndWhenAllowed()
    {
        static async Task<string?[]> NamesAsync(McpGateway gateway)
        {
            await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
            using var client = Client(gateway);
            using HttpResponseMessage response = await client.PostAsync(
                gateway.Endpoint,
                new StringContent("""{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}""", Encoding.UTF8, "application/json"));
            JsonNode body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
            return body["result"]!["tools"]!.AsArray().Select(tool => (string?)tool!["name"]).ToArray();
        }

        await using (var without = new McpGateway(new HttpClient(new Upstream()), new Context()))
        {
            Assert.DoesNotContain(McpGateway.AddToProjectToolName, await NamesAsync(without));
        }

        await using (var with = new McpGateway(new HttpClient(new Upstream()), new Context(), new Adder(this.ProjectPath, true)))
        {
            Assert.Contains(McpGateway.AddToProjectToolName, await NamesAsync(with));
        }

        await using var off = new McpGateway(new HttpClient(new Upstream()), new Context(), new Adder(this.ProjectPath, true))
        {
            AllowedTools = new HashSet<string> { "metadata_search" },
        };
        Assert.DoesNotContain(McpGateway.AddToProjectToolName, await NamesAsync(off));
    }

    private static string ProjectXml(string items) => $"""
        <?xml version="1.0" encoding="utf-8"?>
        <Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
          <PropertyGroup>
            <Name>MyProject</Name>
            <Model>My Model</Model>
          </PropertyGroup>
          <ItemGroup>{items}</ItemGroup>
        </Project>
        """;

    private static HttpClient Client(McpGateway gateway)
    {
        var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", gateway.BearerToken);
        return client;
    }

    private string Save(string aotType, string name)
    {
        string path = Path.Combine(this.ModelDir, aotType, name + ".xml");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, $"<{aotType} />");
        return path;
    }

    private async Task<JsonNode> CallAsync(Adder adder, JsonObject arguments)
    {
        var upstream = new Upstream();
        await using var gateway = new McpGateway(new HttpClient(upstream), new Context(), adder) { CustomMetadataDirectory = this.CustomDir };
        await gateway.StartAsync("https://app.example.net", "upstream-secret", null, CancellationToken.None);
        using HttpClient client = Client(gateway);
        var request = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 4,
            ["method"] = "tools/call",
            ["params"] = new JsonObject { ["name"] = McpGateway.AddToProjectToolName, ["arguments"] = arguments },
        };
        using HttpResponseMessage response = await client.PostAsync(gateway.Endpoint, new StringContent(request.ToJsonString(), Encoding.UTF8, "application/json"));
        JsonNode body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal(0, upstream.RequestCount);
        Assert.Equal(4, (int)body["id"]!);
        return body["result"]!;
    }

    /// <summary>Stands in for Visual Studio's project system; it either records the item in the .rnrproj or ignores it.</summary>
    private sealed class Adder(string projectPath, bool writesProject) : IProjectFileAdder
    {
        public List<string> Added { get; } = [];

        public string? FindError { get; init; }

        public Task<string> FindProjectAsync(string? projectName, CancellationToken cancellationToken) =>
            this.FindError is null ? Task.FromResult(projectPath) : throw new InvalidOperationException(this.FindError);

        public Task AddFilesAsync(string project, IReadOnlyList<string> paths, CancellationToken cancellationToken)
        {
            this.Added.AddRange(paths);
            if (writesProject)
            {
                string items = string.Concat(paths.Select(path =>
                    $"""<Content Include="{Path.GetFileName(Path.GetDirectoryName(path))}\{Path.GetFileNameWithoutExtension(path)}" />"""));
                File.WriteAllText(project, File.ReadAllText(project).Replace("</ItemGroup>", items + "</ItemGroup>", StringComparison.Ordinal));
            }

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
        public int RequestCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            this.RequestCount++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"metadata_search"}]}}""", Encoding.UTF8, "application/json"),
            });
        }
    }
}
