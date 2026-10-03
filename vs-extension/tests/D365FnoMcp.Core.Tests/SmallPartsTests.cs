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
