using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public sealed class XppConfigurationTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "xpp-" + Guid.NewGuid().ToString("N"));

    public XppConfigurationTests()
    {
        Directory.CreateDirectory(this.root);
    }

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    /// <summary>The shape Visual Studio writes, with the custom folder deliberately not named Metadata.</summary>
    private string WriteConfig(string name, string version, string modelStore, DateTime? savedUtc = null)
    {
        string json = $$"""
            {
              "AdminIdentityProvider": "https://sts.windows.net/",
              "BusinessDatabasePassword": "never-read",
              "CrossReferencesDatabaseName": "XRef_{{name}}",
              "CrossReferencesDbServerName": "(LocalDB)\\MSSQLLocalDB",
              "DebugSourceFolder": {{System.Text.Json.JsonSerializer.Serialize(modelStore)}},
              "DefaultModelForNewProjects": "FleetManagement",
              "FrameworkDirectory": "C:\\Users\\dev\\AppData\\Local\\Microsoft\\Dynamics365\\{{version}}\\PackagesLocalDirectory",
              "ModelStoreFolder": {{System.Text.Json.JsonSerializer.Serialize(modelStore)}},
              "ReferencePackagesPaths": [
                "C:\\Users\\dev\\AppData\\Local\\Microsoft\\Dynamics365\\{{version}}\\PackagesLocalDirectory"
              ],
              "RuntimeHostType": 4
            }
            """;
        string file = Path.Combine(this.root, $"{name}__{version}.json");
        File.WriteAllText(file, json);
        if (savedUtc is DateTime saved)
        {
            File.SetLastWriteTimeUtc(file, saved);
        }

        return file;
    }

    [Fact]
    public void ReadsTheFieldsTheExtensionUses()
    {
        WriteConfig("zelesta-dev", "10.0.2790.105", @"C:\src\Zelesta-ERP\CustomCode");

        XppConfiguration config = Assert.Single(XppConfigurations.List(this.root));

        Assert.Equal("zelesta-dev", config.Name);
        Assert.Equal("10.0.2790.105", config.Version);
        Assert.Equal(@"C:\src\Zelesta-ERP\CustomCode", config.ModelStoreFolder);
        Assert.Equal(@"C:\Users\dev\AppData\Local\Microsoft\Dynamics365\10.0.2790.105\PackagesLocalDirectory", config.FrameworkDirectory);
        Assert.Single(config.ReferencePackagesPaths);
        Assert.Equal(@"(LocalDB)\MSSQLLocalDB", config.CrossReferencesDbServerName);
        Assert.Equal("XRef_zelesta-dev", config.CrossReferencesDatabaseName);
        Assert.Equal("FleetManagement", config.DefaultModelForNewProjects);
    }

    [Fact]
    public void SkipsBrokenFilesAndOtherJson()
    {
        WriteConfig("good", "10.0.1", @"C:\custom");
        File.WriteAllText(Path.Combine(this.root, "broken__10.0.2.json"), "{ not json");
        File.WriteAllText(Path.Combine(this.root, "other.json"), """{ "Something": "else" }""");

        Assert.Equal(["good"], XppConfigurations.List(this.root).Select(c => c.Name));
    }

    [Fact]
    public void AMissingFolderHasNoConfigurations()
    {
        Assert.Empty(XppConfigurations.List(Path.Combine(this.root, "missing")));
        Assert.Null(XppConfigurations.Choose([], null).Configuration);
    }

    [Fact]
    public void FollowsTheOnlyConfiguration()
    {
        WriteConfig("only", "10.0.1", @"C:\custom");

        XppConfigurationChoice choice = XppConfigurations.Choose(XppConfigurations.List(this.root), null);

        Assert.Equal("only", choice.Configuration?.Name);
        Assert.Contains("only one", choice.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void WithSeveralFollowsTheNewestAndSaysItGuessed()
    {
        WriteConfig("older", "10.0.1", @"C:\a", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        WriteConfig("newer", "10.0.2", @"C:\b", new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));

        XppConfigurationChoice choice = XppConfigurations.Choose(XppConfigurations.List(this.root), null);

        Assert.Equal("newer", choice.Configuration?.Name);
        Assert.Contains("Select XPP Configuration", choice.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void APinWinsAndAMissingPinChoosesNothing()
    {
        WriteConfig("older", "10.0.1", @"C:\a", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        WriteConfig("newer", "10.0.2", @"C:\b", new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc));
        IReadOnlyList<XppConfiguration> all = XppConfigurations.List(this.root);

        Assert.Equal("older", XppConfigurations.Choose(all, "OLDER").Configuration?.Name);
        XppConfigurationChoice gone = XppConfigurations.Choose(all, "deleted");
        Assert.Null(gone.Configuration);
        Assert.Contains("no longer exists", gone.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("zelesta-dev__10.0.2790.105", "zelesta-dev", "10.0.2790.105")]
    [InlineData("my__config__10.0.1", "my__config", "10.0.1")]
    [InlineData("noversion", "noversion", null)]
    [InlineData("name__notaversion", "name__notaversion", null)]
    public void SplitsTheFileName(string fileName, string name, string? version)
    {
        Assert.Equal((name, version), XppConfigurations.SplitFileName(fileName));
    }

    [Fact]
    public void GivesEachConfigurationItsOwnIndexFile()
    {
        WriteConfig("a b", "10.0.1", @"C:\a");
        WriteConfig("c", "10.0.1", @"C:\c");
        IReadOnlyList<XppConfiguration> all = XppConfigurations.List(this.root);

        string[] paths = all.Select(c => IndexFileLock.PathFor(this.root, c)).ToArray();

        Assert.Equal(2, paths.Distinct().Count());
        Assert.All(paths, p => Assert.DoesNotContain(" ", Path.GetFileName(p), StringComparison.Ordinal));
    }

    [Fact]
    public void AnIndexFileIsHeldByOneOwnerAtATime()
    {
        string index = Path.Combine(this.root, "indexes", "x.db");

        using (IndexFileLock? first = IndexFileLock.TryAcquire(index))
        {
            Assert.NotNull(first);
            Assert.Null(IndexFileLock.TryAcquire(index));
        }

        using IndexFileLock? again = IndexFileLock.TryAcquire(index);
        Assert.NotNull(again);
    }
}

public sealed class CustomModelsFolderTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "custom-" + Guid.NewGuid().ToString("N"));

    public CustomModelsFolderTests()
    {
        Directory.CreateDirectory(this.root);
    }

    public void Dispose() => Directory.Delete(this.root, recursive: true);

    private void AddObject(string package, string model, string type, string name)
    {
        string folder = Path.Combine(this.root, package, model, type);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, name + ".xml"), $"<{type}><Name>{name}</Name></{type}>");
    }

    [Fact]
    public void AcceptsAFolderOfPackagesWhateverItsName()
    {
        AddObject("ZelestaPackage", "ZelestaModel", "AxTable", "ZelDailyPrice");
        AddObject("ZelestaPackage", "ZelestaExtensions", "AxClass", "ZelHelper");
        AddObject("Other", "OtherModel", "AxEnum", "OtherEnum");
        Directory.CreateDirectory(Path.Combine(this.root, "Empty", "NoXml", "AxClass"));

        CustomModelsFolderReport report = CustomModelsFolder.Inspect(this.root);

        Assert.True(report.IsValid);
        Assert.Equal(["Other", "ZelestaPackage"], report.Packages);
        Assert.Equal(3, report.ModelCount);
        Assert.Contains("ZelestaPackage", report.Summary, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsAPackageFolderChosenByMistake()
    {
        AddObject("ZelestaPackage", "ZelestaModel", "AxTable", "ZelDailyPrice");

        CustomModelsFolderReport report = CustomModelsFolder.Inspect(Path.Combine(this.root, "ZelestaPackage"));

        Assert.False(report.IsValid);
        Assert.Contains("not a package or model folder", report.Summary, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectsAMissingFolder()
    {
        CustomModelsFolderReport report = CustomModelsFolder.Inspect(Path.Combine(this.root, "missing"));

        Assert.False(report.IsValid);
        Assert.Contains("does not exist", report.Summary, StringComparison.Ordinal);
    }

    [Fact]
    public void ComparesFoldersLikeWindows()
    {
        Assert.True(CustomModelsFolder.SameFolder(this.root, this.root.ToUpperInvariant() + Path.DirectorySeparatorChar) || !OperatingSystem.IsWindows());
        Assert.True(CustomModelsFolder.SameFolder(this.root, this.root + Path.DirectorySeparatorChar));
        Assert.False(CustomModelsFolder.SameFolder(this.root, Path.Combine(this.root, "x")));
        Assert.False(CustomModelsFolder.SameFolder(null, this.root));
    }
}
