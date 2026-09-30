using System.Globalization;
using System.Text;
using System.Text.Json;

namespace D365FnoMcp.Core;

public sealed record ServedIndexInfo(string? BuiltAt, string? Version, string? Source, long? Objects, string? XrefImportedAt);

public sealed record LocalIndexInfo(string? BuiltAt, long Objects, string? XrefImportedAt);

public sealed record ModelChanges(string Model, int Files);

public sealed record ChangedFile(string Path, string Kind, string Model);

/// <summary>What <c>index-status --json</c> printed: whether the served index is current for this machine's packages folder.</summary>
public sealed record IndexStatusReport(
    bool UpToDate,
    string Basis,
    IReadOnlyList<string> Reasons,
    ServedIndexInfo? Server,
    LocalIndexInfo? Local,
    bool LocalNewerThanServer,
    int ScannedFiles,
    int Added,
    int Changed,
    int? Removed,
    IReadOnlyList<ModelChanges> Models,
    IReadOnlyList<ChangedFile> Files,
    long ScanMs)
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>Reads the status object, or null when the line is not one.</summary>
    public static IndexStatusReport? TryParse(string line)
    {
        if (!line.TrimStart().StartsWith('{'))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(line);
            return document.RootElement.TryGetProperty("upToDate", out _)
                ? document.RootElement.Deserialize<IndexStatusReport>(Options)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Plain text for a Visual Studio prompt and the Output pane.</summary>
    public string Summary(DateTimeOffset now)
    {
        var builder = new StringBuilder();
        if (this.UpToDate)
        {
            builder.AppendLine("The index is up to date.");
        }
        else
        {
            builder.AppendLine("The index is out of date:");
            foreach (string reason in this.Reasons)
            {
                builder.AppendLine($"- {reason}");
            }
        }

        builder.AppendLine();
        if (this.Server is not null)
        {
            string objects = this.Server.Objects is long count ? $", {count.ToString("N0", CultureInfo.InvariantCulture)} objects" : string.Empty;
            builder.AppendLine($"Server index: built {Age(this.Server.BuiltAt, now)}{objects}");
            if (this.Server.XrefImportedAt is not null)
            {
                builder.AppendLine($"Server XRef: imported {Age(this.Server.XrefImportedAt, now)}");
            }
        }

        if (this.Local is not null)
        {
            builder.AppendLine($"Local index: built {Age(this.Local.BuiltAt, now)}");
        }

        string removed = this.Removed is int gone ? $", {gone} removed" : string.Empty;
        builder.AppendLine($"Files: {this.Added} added, {this.Changed} changed{removed}");
        foreach (ModelChanges model in this.Models.Take(5))
        {
            builder.AppendLine($"  {model.Model}: {model.Files}");
        }

        if (this.Models.Count > 5)
        {
            builder.AppendLine($"  and {this.Models.Count - 5} more model(s)");
        }

        builder.Append(CultureInfo.InvariantCulture, $"Scanned {this.ScannedFiles:N0} files in {this.ScanMs / 1000.0:F1} s");
        builder.Append(this.Basis == "timestamp"
            ? " against the server's build time (no matching local index, so removed files are not counted)."
            : " against the local index.");
        return builder.ToString();
    }

    /// <summary>"2026-09-20 14:02 UTC (9 days ago)".</summary>
    public static string Age(string? iso, DateTimeOffset now)
    {
        if (iso is null || !DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out DateTimeOffset time))
        {
            return iso ?? "at an unknown time";
        }

        TimeSpan elapsed = now - time;
        string ago = elapsed.TotalHours < 1 ? "less than an hour ago"
            : elapsed.TotalHours < 48 ? $"{(int)elapsed.TotalHours} hour(s) ago"
            : $"{(int)elapsed.TotalDays} day(s) ago";
        return $"{time.UtcDateTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)} UTC ({ago})";
    }
}

public sealed record IndexStatusOutcome(IndexStatusReport? Report, string? Error);

/// <summary>Runs <c>index-status</c> for the saved settings and reads its JSON answer.</summary>
public static class IndexStatusCheck
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
            problems.Add("Configure the server connection first (Extensions > D365 F&O MCP > Configure Connection).");
        }

        if (string.IsNullOrWhiteSpace(settings.PackagesDirectory) || !directoryExists(settings.PackagesDirectory))
        {
            problems.Add("Choose the PackagesLocalDirectory folder in Index and Upload first.");
        }

        return problems;
    }

    public static CliStep Plan(ExtensionSettings settings, string apiKey) => new(
        "Check index",
        new[]
        {
            "index-status",
            "--packages-dir", settings.PackagesDirectory,
            "--db-path", settings.IndexDbPath,
            "--server", ServerUrl.Normalize(settings.ServerUrl),
            "--json",
        },
        new Dictionary<string, string> { ["D365_MCP_API_KEY"] = apiKey },
        JsonProgress: true);

    public static async Task<IndexStatusOutcome> RunAsync(
        CliLaunch launch, ExtensionSettings settings, string apiKey, Action<string, bool> log, CancellationToken cancellationToken)
    {
        CliStep step = Plan(settings, apiKey);
        IndexStatusReport? report = null;
        string? error = null;
        int exitCode = await CliRunner.RunAsync(
            launch,
            step,
            (line, isError) =>
            {
                if (!isError)
                {
                    IndexStatusReport? parsed = IndexStatusReport.TryParse(line);
                    if (parsed is not null)
                    {
                        report = parsed;
                        return;
                    }

                    error = ReadError(line) ?? error;
                }

                log(line, isError);
            },
            cancellationToken,
            Directory.Exists(Path.GetDirectoryName(settings.IndexDbPath)) ? Path.GetDirectoryName(settings.IndexDbPath) : null);

        if (report is not null && exitCode == 0)
        {
            return new IndexStatusOutcome(report, null);
        }

        return new IndexStatusOutcome(null, error ?? $"The index check failed (exit code {exitCode}); see the Output pane.");
    }

    private static string? ReadError(string line)
    {
        if (!line.TrimStart().StartsWith('{'))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(line);
            return document.RootElement.TryGetProperty("error", out JsonElement message) && message.ValueKind == JsonValueKind.String
                ? message.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
