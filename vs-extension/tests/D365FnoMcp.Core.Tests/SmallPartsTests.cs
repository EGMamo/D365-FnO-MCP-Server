using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class ServerUrlTests
{
    [Theory]
    [InlineData("https://app.example.net", "https://app.example.net")]
    [InlineData("https://app.example.net/mcp", "https://app.example.net")]
    [InlineData(" https://app.example.net/MCP/?x=1 ", "https://app.example.net")]
    [InlineData("http://localhost:3000/base/mcp", "http://localhost:3000/base")]
    public void Normalizes(string input, string expected) => Assert.Equal(expected, ServerUrl.Normalize(input));

    [Theory]
    [InlineData("")]
    [InlineData("app.example.net")]
    [InlineData("ftp://app.example.net")]
    public void RejectsNonHttpUrls(string input) => Assert.Throws<FormatException>(() => ServerUrl.Normalize(input));

    [Fact]
    public void FlagsPlainHttpOnlyForRemoteHosts()
    {
        Assert.True(ServerUrl.IsInsecure("http://app.example.net"));
        Assert.False(ServerUrl.IsInsecure("http://127.0.0.1:3000"));
        Assert.False(ServerUrl.IsInsecure("https://app.example.net"));
    }
}

public class XrefConnectionTests
{
    [Fact]
    public void WindowsAuthenticationBuildsAnOdbcString()
    {
        var settings = new ExtensionSettings { XrefServer = @"(localdb)\MSSQLLocalDB", XrefDatabase = "DYNAMICSXREFDB" };
        Assert.Equal(
            @"Driver={ODBC Driver 17 for SQL Server};Server=(localdb)\MSSQLLocalDB;Database=DYNAMICSXREFDB;Trusted_Connection=yes;TrustServerCertificate=yes;",
            XrefConnection.Build(settings, null));
    }

    [Fact]
    public void SqlLoginQuotesAwkwardValues()
    {
        var settings = new ExtensionSettings
        {
            XrefServer = "devvm",
            XrefDatabase = "DYNAMICSXREFDB",
            XrefAuthentication = XrefAuthentication.SqlLogin,
            XrefUser = "reader",
            XrefTrustServerCertificate = false,
        };
        Assert.Equal(
            "Server=devvm;Database=DYNAMICSXREFDB;User Id=reader;Password=\"p;a\"\"ss\";Encrypt=true;TrustServerCertificate=false;",
            XrefConnection.Build(settings, "p;a\"ss"));
        Assert.Throws<ArgumentException>(() => XrefConnection.Build(settings, null));
    }

    [Fact]
    public void BracesOdbcValuesThatContainSeparators() => Assert.Equal("{a;b}}c}", XrefConnection.EscapeOdbc("a;b}c"));
}

public class CliLocatorTests
{
    private static readonly char Sep = Path.PathSeparator;

    [Fact]
    public void PrefersTheScriptBehindAnNpmShimOnPath()
    {
        string bin = Path.Combine("tools", "npm");
        string shim = Path.Combine(bin, "d365-fno-mcp-server.cmd");
        string script = Path.Combine(bin, "node_modules", "d365-fno-mcp-server", "dist", "src", "index.js");
        var locator = new CliLocator(file => file == shim || file == script, _ => false, $"other{Sep}{bin}");

        CliLaunch launch = locator.Resolve("d365-fno-mcp-server", "node");

        Assert.Equal("node", launch.FileName);
        Assert.Equal(new[] { script }, launch.PrefixArguments);
    }

    [Fact]
    public void AcceptsAScriptOrARepositoryFolder()
    {
        string repo = Path.Combine("src", "repo");
        string script = Path.Combine(repo, "dist", "src", "index.js");
        var locator = new CliLocator(file => file == script, dir => dir == repo, string.Empty);

        Assert.Equal(new[] { script }, locator.Resolve(repo, @"C:\node\node.exe").PrefixArguments);
        Assert.Equal(@"C:\node\node.exe", locator.Resolve($"\"{script}\"", @"C:\node\node.exe").FileName);
        Assert.Throws<FileNotFoundException>(() => locator.Resolve("d365-fno-mcp-server", "node"));
        Assert.Throws<FileNotFoundException>(() => locator.Resolve("missing.js", "node"));
    }
}

public class PackagesDirectoryLocatorTests
{
    [Fact]
    public void ListsTheNewestUnifiedInstallFirst()
    {
        string root = Path.Combine("appdata", "Microsoft", "Dynamics365");
        var dirs = new HashSet<string>
        {
            root,
            Path.Combine(root, "10.0.2015.54", "PackagesLocalDirectory"),
            Path.Combine(root, "10.0.2095.13", "PackagesLocalDirectory"),
            @"K:\AosService\PackagesLocalDirectory",
        };
        IReadOnlyList<string> found = PackagesDirectoryLocator.Candidates(
            "appdata",
            _ => new[] { Path.Combine(root, "10.0.2015.54"), Path.Combine(root, "10.0.2095.13"), Path.Combine(root, "empty") },
            dirs.Contains);

        Assert.Equal(
            new[]
            {
                Path.Combine(root, "10.0.2095.13", "PackagesLocalDirectory"),
                Path.Combine(root, "10.0.2015.54", "PackagesLocalDirectory"),
                @"K:\AosService\PackagesLocalDirectory",
            },
            found);
    }
}

public class ProgressEventTests
{
    [Fact]
    public void ParsesEachEventKind()
    {
        ProgressEvent progress = ProgressEvent.TryParse("""{"event":"progress","stage":"upload","done":50,"total":200}""")!;
        Assert.Equal(ProgressKind.Progress, progress.Kind);
        Assert.Equal(25, progress.Percent);

        ProgressEvent check = ProgressEvent.TryParse("""{"event":"check","name":"checksum","ok":true,"expected":"local a","actual":"server a"}""")!;
        Assert.True(check.Ok);
        Assert.Equal("checksum", check.Name);

        ProgressEvent result = ProgressEvent.TryParse("""{"event":"result","ok":true,"index":{"version":"20260926T080000Z-abcdef12"}}""")!;
        Assert.Equal("20260926T080000Z-abcdef12", (string?)result.Raw!["index"]!["version"]);

        Assert.Equal("boom", ProgressEvent.TryParse("""{"event":"error","message":"boom"}""")!.Message);
        Assert.Contains("chunk 3", ProgressEvent.TryParse("""{"event":"retry","chunk":3,"attempt":1,"reason":"HTTP 503"}""")!.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("Indexing complete:")]
    [InlineData("{not json")]
    [InlineData("""{"ts":"2026-09-26T00:00:00Z","level":"INFO","message":"log line"}""")]
    public void IgnoresOtherLines(string line) => Assert.Null(ProgressEvent.TryParse(line));
}

public class SettingsStoreTests
{
    [Fact]
    public void RoundTripsAndSurvivesADamagedFile()
    {
        string dir = Directory.CreateTempSubdirectory().FullName;
        try
        {
            var store = new SettingsStore(Path.Combine(dir, "nested", "settings.json"));
            Assert.Equal("d365-fno", store.Load().McpServerName);

            store.Save(new ExtensionSettings { ServerUrl = "https://a.example.net", Compression = UploadCompression.Brotli, ChunkSizeMb = 64 });
            ExtensionSettings loaded = store.Load();
            Assert.Equal("https://a.example.net", loaded.ServerUrl);
            Assert.Equal(UploadCompression.Brotli, loaded.Compression);
            Assert.Equal(64, loaded.ChunkSizeMb);
            Assert.Contains("\"Brotli\"", File.ReadAllText(store.Path));

            File.WriteAllText(store.Path, "{ damaged");
            Assert.Equal(string.Empty, store.Load().ServerUrl);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SecretNamesIgnoreUrlSpelling() =>
        Assert.Equal(SecretNames.ApiKey("https://app.example.net/mcp/"), SecretNames.ApiKey("https://app.example.net"));
}

public class IndexJobTests
{
    private static ExtensionSettings Settings() => new()
    {
        ServerUrl = "https://app.example.net/mcp",
        PackagesDirectory = Path.GetTempPath(),
        IndexDbPath = Path.Combine(Path.GetTempPath(), "index", "d365_index.db"),
        XrefAuthentication = XrefAuthentication.SqlLogin,
        XrefUser = "reader",
        Compression = UploadCompression.Brotli,
        CompressionLevel = CompressionLevel.Smallest,
        ChunkSizeMb = 16,
        ParallelUploads = 3,
    };

    [Fact]
    public void PlansIndexXrefAndUploadWithSecretsOnlyInTheEnvironment()
    {
        IReadOnlyList<CliStep> steps = IndexJob.Plan(Settings(), new JobSecrets("the-api-key", "the-password"));

        Assert.Equal(new[] { "Index", "Import XRef", "Upload" }, steps.Select(s => s.Name));
        Assert.Equal(new[] { "index", "--packages-dir", Path.GetTempPath(), "--db-path", Settings().IndexDbPath }, steps[0].Arguments);
        Assert.Contains("Password=the-password", steps[1].Environment["D365_XREF_CONNECTION_STRING"]);
        Assert.Equal(
            new[]
            {
                "upload-index", "--server", "https://app.example.net", "--db-path", Settings().IndexDbPath,
                "--compression", "brotli", "--level", "smallest", "--parallel", "3", "--progress", "json",
                "--chunk-size", "16", "--relative-paths",
            },
            steps[2].Arguments);
        Assert.Equal("the-api-key", steps[2].Environment["D365_MCP_API_KEY"]);
        Assert.Equal(Path.GetTempPath(), steps[2].Environment["D365_PACKAGES_DIR"]);
        Assert.True(steps[2].JsonProgress);
        Assert.DoesNotContain(steps.SelectMany(s => s.Arguments), a => a.Contains("the-api-key") || a.Contains("the-password"));
    }

    [Fact]
    public void CanSkipXrefAndChunking()
    {
        ExtensionSettings settings = Settings();
        settings.ImportXref = false;
        settings.UseChunks = false;
        settings.Compression = UploadCompression.None;
        settings.RelativePaths = false;
        IReadOnlyList<CliStep> steps = IndexJob.Plan(settings, new JobSecrets("k", null));

        Assert.Equal(new[] { "Index", "Upload" }, steps.Select(s => s.Name));
        Assert.Contains("--no-chunks", steps[1].Arguments);
        Assert.DoesNotContain("--chunk-size", steps[1].Arguments);
        Assert.Contains("none", steps[1].Arguments);
        Assert.False(steps[1].Environment.ContainsKey("D365_PACKAGES_DIR"));
    }

    [Fact]
    public void ValidatesBeforeRunning()
    {
        var settings = new ExtensionSettings { ServerUrl = "", PackagesDirectory = "missing", IndexDbPath = "relative.db", XrefAuthentication = XrefAuthentication.SqlLogin, ChunkSizeMb = 0, ParallelUploads = 0 };
        IReadOnlyList<string> problems = IndexJob.Validate(settings, _ => false);
        Assert.Equal(6, problems.Count);
        Assert.Empty(IndexJob.Validate(Settings(), _ => true));
    }
}
