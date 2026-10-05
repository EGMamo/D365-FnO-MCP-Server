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

    [Theory]
    [InlineData("https://app.example.net/mcp", "https://app.example.net")]
    [InlineData("http://localhost:3000", "http://localhost:3000")]
    [InlineData("http://127.0.0.1:3000/mcp", "http://127.0.0.1:3000")]
    [InlineData("http://[::1]:3000", "http://[::1]:3000")]
    public void AcceptsHttpsAndLoopbackHttp(string input, string expected) =>
        Assert.Equal(expected, ServerUrl.NormalizeSecure(input));

    [Theory]
    [InlineData("http://app.example.net")]
    [InlineData("http://10.0.0.5:3000/mcp")]
    public void RejectsPlainHttpToRemoteHosts(string input)
    {
        Assert.Throws<FormatException>(() => ServerUrl.NormalizeSecure(input));
        Assert.Throws<FormatException>(() => ServerUrl.McpEndpoint(input));
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

    [Fact]
    public void OrdersUnifiedInstallsByVersionNumberNotText()
    {
        string root = Path.Combine("appdata", "Microsoft", "Dynamics365");
        string[] versions = { "10.0.999.20", "10.0.2095.13", "preview", "10.0.10000.1" };
        var dirs = new HashSet<string>(versions.Select(v => Path.Combine(root, v, "PackagesLocalDirectory"))) { root };

        IReadOnlyList<string> found = PackagesDirectoryLocator.Candidates(
            "appdata",
            _ => versions.Select(v => Path.Combine(root, v)),
            dirs.Contains);

        Assert.Equal(
            new[] { "10.0.10000.1", "10.0.2095.13", "10.0.999.20", "preview" },
            found.Select(path => Path.GetFileName(Path.GetDirectoryName(path))));
    }

    [Fact]
    public void ReportsAnSdkVersionOnlyForVersionFolders()
    {
        Assert.Equal("10.0.2095.13", PackagesDirectoryLocator.SdkVersion(Path.Combine("appdata", "Dynamics365", "10.0.2095.13", "PackagesLocalDirectory")));
        Assert.Null(PackagesDirectoryLocator.SdkVersion(Path.Combine("K:", "AosService", "PackagesLocalDirectory")));
        Assert.Null(PackagesDirectoryLocator.SdkVersion(@"K:\AosService\PackagesLocalDirectory"));
        Assert.Null(PackagesDirectoryLocator.SdkVersion(null));
    }
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

            store.Save(new ExtensionSettings
            {
                ServerUrl = "https://a.example.net",
                McpConfigurationPath = Path.Combine(dir, ".mcp.json"),
            });
            ExtensionSettings loaded = store.Load();
            Assert.Equal("https://a.example.net", loaded.ServerUrl);
            Assert.EndsWith(".mcp.json", loaded.McpConfigurationPath);

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

public class ApiKeyEntryTests
{
    [Theory]
    [InlineData("  new-key\r\n", null, "new-key")]
    [InlineData("new-key", "saved-key", "new-key")]
    [InlineData("", "saved-key", "saved-key")]
    [InlineData("   ", "saved-key", "saved-key")]
    [InlineData("", null, null)]
    [InlineData("", "  ", null)]
    public void ResolvesTypedOrSavedKey(string entered, string? saved, string? expected) =>
        Assert.Equal(expected, ApiKeyEntry.Resolve(entered, saved));
}
