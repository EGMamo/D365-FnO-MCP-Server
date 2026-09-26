namespace D365FnoMcp.Core;

/// <summary>One CLI run: arguments plus environment variables (secrets travel only in the environment).</summary>
public sealed record CliStep(string Name, IReadOnlyList<string> Arguments, IReadOnlyDictionary<string, string> Environment, bool JsonProgress);

/// <summary>Secrets the job needs, read from the secret store just before it starts.</summary>
public sealed record JobSecrets(string ApiKey, string? XrefPassword);

/// <summary>
/// Turns the settings into the CLI steps the "Index and upload" window runs:
/// index the packages folder, import the XRef database, upload with the
/// chosen compression and chunking.
/// </summary>
public static class IndexJob
{
    public static IReadOnlyList<string> Validate(ExtensionSettings settings, Func<string, bool> directoryExists)
    {
        var problems = new List<string>();
        try
        {
            ServerUrl.Normalize(settings.ServerUrl);
        }
        catch (FormatException)
        {
            problems.Add("Configure the server connection first (Extensions > D365 F&O MCP > Configure connection).");
        }

        if (string.IsNullOrWhiteSpace(settings.PackagesDirectory) || !directoryExists(settings.PackagesDirectory))
        {
            problems.Add("Choose an existing PackagesLocalDirectory folder to index.");
        }

        if (string.IsNullOrWhiteSpace(settings.IndexDbPath) || !Path.IsPathFullyQualified(settings.IndexDbPath))
        {
            problems.Add("The index database path must be a full path.");
        }

        if (settings.ImportXref)
        {
            if (string.IsNullOrWhiteSpace(settings.XrefServer) || string.IsNullOrWhiteSpace(settings.XrefDatabase))
            {
                problems.Add("Enter the SQL Server and database of the XRef database, or turn the XRef import off.");
            }

            if (settings.XrefAuthentication == XrefAuthentication.SqlLogin && string.IsNullOrWhiteSpace(settings.XrefUser))
            {
                problems.Add("Enter the SQL login for the XRef database.");
            }
        }

        if (settings.UseChunks && (settings.ChunkSizeMb < 1 || settings.ChunkSizeMb > 4096))
        {
            problems.Add("Chunk size must be between 1 and 4096 MiB.");
        }

        if (settings.ParallelUploads < 1 || settings.ParallelUploads > 16)
        {
            problems.Add("Parallel uploads must be between 1 and 16.");
        }

        return problems;
    }

    public static IReadOnlyList<CliStep> Plan(ExtensionSettings settings, JobSecrets secrets)
    {
        string dbPath = settings.IndexDbPath;
        var steps = new List<CliStep>();

        var indexArgs = new List<string> { "index", "--packages-dir", settings.PackagesDirectory, "--db-path", dbPath };
        steps.Add(new CliStep("Index", indexArgs, new Dictionary<string, string>(), JsonProgress: false));

        if (settings.ImportXref)
        {
            steps.Add(new CliStep(
                "Import XRef",
                new[] { "index-xref", "--db-path", dbPath },
                new Dictionary<string, string> { ["D365_XREF_CONNECTION_STRING"] = XrefConnection.Build(settings, secrets.XrefPassword) },
                JsonProgress: false));
        }

        var upload = new List<string>
        {
            "upload-index",
            "--server", ServerUrl.Normalize(settings.ServerUrl),
            "--db-path", dbPath,
            "--compression", settings.Compression switch
            {
                UploadCompression.Brotli => "brotli",
                UploadCompression.None => "none",
                _ => "gzip",
            },
            "--level", settings.CompressionLevel.ToString().ToLowerInvariant(),
            "--parallel", settings.ParallelUploads.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "--progress", "json",
        };
        if (settings.UseChunks)
        {
            upload.AddRange(new[] { "--chunk-size", settings.ChunkSizeMb.ToString(System.Globalization.CultureInfo.InvariantCulture) });
        }
        else
        {
            upload.Add("--no-chunks");
        }

        var uploadEnvironment = new Dictionary<string, string> { ["D365_MCP_API_KEY"] = secrets.ApiKey };
        if (settings.RelativePaths)
        {
            upload.Add("--relative-paths");
            uploadEnvironment["D365_PACKAGES_DIR"] = settings.PackagesDirectory;
        }

        steps.Add(new CliStep("Upload", upload, uploadEnvironment, JsonProgress: true));
        return steps;
    }

    /// <summary>Removes the index and its SQLite side files so the next run builds a new one.</summary>
    public static void DeleteIndex(string dbPath)
    {
        foreach (string suffix in new[] { string.Empty, "-wal", "-shm", ".manifest.json" })
        {
            string file = dbPath + suffix;
            if (File.Exists(file))
            {
                File.Delete(file);
            }
        }
    }
}
