using System.Diagnostics;
using System.Text.Json.Nodes;
using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

/// <summary>
/// Drives the real CLI against a real server: index a packages folder, upload
/// it with each compression, and check what the server then reports. Runs when
/// the repository's dist/ is built and Node.js is on PATH; skipped otherwise.
/// </summary>
public class EndToEndTests
{
    private const string UploaderKey = "e2e-uploader-key-000000000000000000000000";

    private sealed class Observer : IIndexUploadObserver
    {
        public List<string> Lines { get; } = new();

        public List<(string Name, bool Ok)> Checks { get; } = new();

        public List<string> Stages { get; } = new();

        public double MaxUploadPercent { get; private set; }

        public void StepStarted(int index, int count, string name) => this.Lines.Add($"step {index + 1}/{count} {name}");

        public void Log(string line, bool isError) => this.Lines.Add(line);

        public void Stage(string stage, string message) => this.Stages.Add(stage);

        public void Progress(string stage, double percent, long done, long total)
        {
            if (stage == "upload")
            {
                this.MaxUploadPercent = Math.Max(this.MaxUploadPercent, percent);
            }
        }

        public void Check(string name, bool ok, string expected, string actual) => this.Checks.Add((name, ok));
    }

    private static string? RepositoryRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "dist", "src", "index.js")) && File.Exists(Path.Combine(dir.FullName, "package.json")))
            {
                return dir.FullName;
            }
        }

        return null;
    }

    private static bool NodeAvailable()
    {
        try
        {
            using Process? node = Process.Start(new ProcessStartInfo("node", "--version") { RedirectStandardOutput = true, UseShellExecute = false });
            node?.WaitForExit(10_000);
            return node?.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    [Theory]
    [InlineData(UploadCompression.Gzip, true)]
    [InlineData(UploadCompression.Brotli, true)]
    [InlineData(UploadCompression.None, false)]
    public async Task IndexesUploadsAndVerifies(UploadCompression compression, bool chunks)
    {
        string? repo = RepositoryRoot();
        if (repo is null || !NodeAvailable())
        {
            return; // Needs `npm run build` and Node.js; the Node test suite covers the server side on its own.
        }

        string root = Directory.CreateTempSubdirectory("d365-vsext-e2e-").FullName;
        Process? server = null;
        try
        {
            string packages = Path.Combine(root, "PackagesLocalDirectory");
            string classDir = Path.Combine(packages, "Package", "Model", "AxClass");
            Directory.CreateDirectory(classDir);
            File.Copy(Path.Combine(repo, "tests", "fixtures", "AxClassSample.xml"), Path.Combine(classDir, "SampleClass.xml"));

            (server, string baseUrl) = await StartServerAsync(repo, Path.Combine(root, "server", "d365_index.db"));

            var settings = new ExtensionSettings
            {
                ServerUrl = baseUrl,
                PackagesDirectory = packages,
                IndexDbPath = Path.Combine(root, "client", "d365_index.db"),
                NewIndex = true,
                ImportXref = false,
                Compression = compression,
                CompressionLevel = CompressionLevel.Fastest,
                UseChunks = chunks,
                ChunkSizeMb = 1,
                ParallelUploads = 2,
            };
            Assert.Empty(IndexJob.Validate(settings, Directory.Exists));

            var observer = new Observer();
            CliLaunch launch = new CliLocator().Resolve(repo, "node");
            IndexUploadResult result = await new IndexUploadRunner(launch).RunAsync(settings, new JobSecrets(UploaderKey, null), observer, CancellationToken.None);

            Assert.True(result.Succeeded, $"{result.Message}{Environment.NewLine}{string.Join(Environment.NewLine, observer.Lines)}");
            Assert.True(result.ChecksumVerified);
            Assert.Contains(("checksum", true), observer.Checks);
            Assert.Contains(("transfer", true), observer.Checks);
            Assert.Contains(("content", true), observer.Checks);
            Assert.Equal(100, observer.MaxUploadPercent);
            Assert.Contains("done", observer.Stages);

            ConnectionReport report = await new ConnectionTester(new HttpClient()).TestAsync(baseUrl, UploaderKey, CancellationToken.None);
            Assert.True(report.Succeeded, report.Summary());
            Assert.True(report.CanUpload);
            Assert.Contains("(upload)", report.Summary());
        }
        finally
        {
            if (server is { HasExited: false })
            {
                server.Kill(entireProcessTree: true);
                await server.WaitForExitAsync();
            }

            server?.Dispose();
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
                // A file still being released on Windows; the temp folder is cleaned up eventually.
            }
        }
    }

    private static async Task<(Process Server, string BaseUrl)> StartServerAsync(string repo, string dbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
        var info = new ProcessStartInfo("node")
        {
            UseShellExecute = false,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            WorkingDirectory = Path.GetDirectoryName(dbPath)!,
        };
        info.ArgumentList.Add(Path.Combine(repo, "dist", "src", "index.js"));
        info.ArgumentList.Add("serve");
        foreach (string key in info.Environment.Keys.Where(k => k.StartsWith("D365_", StringComparison.Ordinal) || k.StartsWith("MCP_", StringComparison.Ordinal)).ToList())
        {
            info.Environment.Remove(key);
        }

        info.Environment["MCP_TRANSPORT"] = "http";
        info.Environment["MCP_PORT"] = "0";
        info.Environment["MCP_HOST"] = "127.0.0.1";
        info.Environment["MCP_API_KEYS"] = $"uploader={UploaderKey}";
        info.Environment["D365_INDEX_UPLOAD_KEYS"] = "uploader";
        info.Environment["D365_INDEX_DB_PATH"] = dbPath;

        Process server = Process.Start(info)!;
        server.OutputDataReceived += (_, _) => { };
        server.BeginOutputReadLine();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (await server.StandardError.ReadLineAsync(timeout.Token) is { } line)
        {
            if (line.StartsWith('{') && JsonNode.Parse(line) is JsonObject log && (string?)log["message"] == "MCP HTTP transport listening")
            {
                // Keep draining stderr so the server never blocks on a full pipe.
                _ = Task.Run(async () =>
                {
                    while (await server.StandardError.ReadLineAsync() is not null)
                    {
                    }
                });
                return (server, $"http://127.0.0.1:{(int)log["port"]!}");
            }
        }

        throw new InvalidOperationException("The server exited before listening.");
    }
}
