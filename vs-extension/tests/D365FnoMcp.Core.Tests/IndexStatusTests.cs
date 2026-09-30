using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class IndexStatusTests
{
    private const string Stale = """
        {"upToDate":false,"basis":"local-index","reasons":["3 file(s) in 2 model(s) changed since the local index was built."],
         "server":{"builtAt":"2026-09-20T12:00:00.000Z","version":"v1","source":"upload","objects":1234,"xrefImportedAt":"2026-09-20T13:00:00.000Z"},
         "local":{"builtAt":"2026-09-20T12:00:00.000Z","objects":1234,"xrefImportedAt":null},"localNewerThanServer":false,
         "scannedFiles":4000,"added":1,"changed":1,"removed":1,
         "models":[{"model":"ModelA","files":2},{"model":"ModelB","files":1}],
         "files":[{"path":"C:\\P\\A\\ModelA\\AxClass\\X.xml","kind":"added","model":"ModelA"}],"scanMs":2500}
        """;

    [Fact]
    public void ParsesTheStatusObject()
    {
        IndexStatusReport? report = IndexStatusReport.TryParse(Stale.ReplaceLineEndings(string.Empty));
        Assert.NotNull(report);
        Assert.False(report!.UpToDate);
        Assert.Equal(1234, report.Server!.Objects);
        Assert.Equal(1, report.Removed);
        Assert.Equal(new ModelChanges("ModelA", 2), report.Models[0]);
        Assert.Equal("added", report.Files[0].Kind);
    }

    [Theory]
    [InlineData("Scanning...")]
    [InlineData("{\"error\":\"nope\"}")]
    [InlineData("{not json")]
    public void IgnoresOtherLines(string line) => Assert.Null(IndexStatusReport.TryParse(line));

    [Fact]
    public void SummarisesForAPrompt()
    {
        IndexStatusReport report = IndexStatusReport.TryParse(Stale.ReplaceLineEndings(string.Empty))!;
        string summary = report.Summary(new DateTimeOffset(2026, 9, 29, 12, 0, 0, TimeSpan.Zero));
        Assert.StartsWith("The index is out of date:", summary);
        Assert.Contains("- 3 file(s) in 2 model(s) changed", summary);
        Assert.Contains("Server index: built 2026-09-20 12:00 UTC (9 day(s) ago), 1,234 objects", summary);
        Assert.Contains("Server XRef: imported 2026-09-20 13:00 UTC", summary);
        Assert.Contains("Files: 1 added, 1 changed, 1 removed", summary);
        Assert.Contains("  ModelA: 2", summary);
        Assert.Contains("Scanned 4,000 files in 2.5 s against the local index.", summary);
    }

    [Fact]
    public void SaysWhenRemovalsCannotBeSeen()
    {
        IndexStatusReport report = IndexStatusReport.TryParse(
            Stale.ReplaceLineEndings(string.Empty).Replace("\"basis\":\"local-index\"", "\"basis\":\"timestamp\"").Replace("\"removed\":1", "\"removed\":null"))!;
        string summary = report.Summary(DateTimeOffset.UtcNow);
        Assert.Contains("Files: 1 added, 1 changed" + Environment.NewLine, summary);
        Assert.Contains("removed files are not counted", summary);
    }

    [Fact]
    public void DescribesAges()
    {
        var now = new DateTimeOffset(2026, 9, 29, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("2026-09-29 11:30 UTC (less than an hour ago)", IndexStatusReport.Age("2026-09-29T11:30:00Z", now));
        Assert.Equal("2026-09-28 12:00 UTC (24 hour(s) ago)", IndexStatusReport.Age("2026-09-28T12:00:00Z", now));
        Assert.Equal("at an unknown time", IndexStatusReport.Age(null, now));
    }

    [Fact]
    public void PlansAReadOnlyCheckWithTheKeyInTheEnvironment()
    {
        var settings = new ExtensionSettings { ServerUrl = "https://mcp.example.com/mcp", PackagesDirectory = @"C:\PLD", IndexDbPath = @"C:\idx\d365_index.db" };
        CliStep step = IndexStatusCheck.Plan(settings, "secret");
        Assert.Equal(new[] { "index-status", "--packages-dir", @"C:\PLD", "--db-path", @"C:\idx\d365_index.db", "--server", "https://mcp.example.com", "--json" }, step.Arguments);
        Assert.Equal("secret", step.Environment["D365_MCP_API_KEY"]);
        Assert.DoesNotContain("secret", step.Arguments);
    }

    [Fact]
    public void ValidatesTheSavedSettings()
    {
        Assert.Equal(2, IndexStatusCheck.Validate(new ExtensionSettings(), _ => false).Count);
        Assert.Empty(IndexStatusCheck.Validate(new ExtensionSettings { ServerUrl = "https://x.example.com", PackagesDirectory = "/p" }, _ => true));
    }
}
