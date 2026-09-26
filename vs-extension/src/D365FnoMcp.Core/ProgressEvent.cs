using System.Text.Json;
using System.Text.Json.Nodes;

namespace D365FnoMcp.Core;

public enum ProgressKind
{
    Stage,
    Progress,
    Retry,
    Check,
    Result,
    Error,
}

/// <summary>One line of <c>upload-index --progress json</c>.</summary>
public sealed record ProgressEvent(
    ProgressKind Kind,
    string? Stage = null,
    string? Message = null,
    long Done = 0,
    long Total = 0,
    string? Name = null,
    bool Ok = false,
    string? Expected = null,
    string? Actual = null,
    JsonObject? Raw = null)
{
    /// <summary>0-100 for a progress event, otherwise null.</summary>
    public double? Percent => this.Kind == ProgressKind.Progress ? (this.Total <= 0 ? 100 : Math.Min(100, this.Done * 100.0 / this.Total)) : null;

    /// <summary>Parses a line, or returns null for anything that is not a progress event.</summary>
    public static ProgressEvent? TryParse(string line)
    {
        if (string.IsNullOrWhiteSpace(line) || line.TrimStart()[0] != '{')
        {
            return null;
        }

        JsonObject? json;
        try
        {
            json = JsonNode.Parse(line) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }

        string? type = (string?)json?["event"];
        return type switch
        {
            "stage" => new ProgressEvent(ProgressKind.Stage, Stage: (string?)json!["stage"], Message: (string?)json["message"], Raw: json),
            "progress" => new ProgressEvent(ProgressKind.Progress, Stage: (string?)json!["stage"], Done: Long(json["done"]), Total: Long(json["total"]), Raw: json),
            "retry" => new ProgressEvent(ProgressKind.Retry, Message: $"chunk {Long(json!["chunk"])}, attempt {Long(json["attempt"])}: {(string?)json["reason"]}", Raw: json),
            "check" => new ProgressEvent(ProgressKind.Check, Name: (string?)json!["name"], Ok: Bool(json["ok"]), Expected: (string?)json["expected"], Actual: (string?)json["actual"], Raw: json),
            "result" => new ProgressEvent(ProgressKind.Result, Ok: Bool(json!["ok"]), Raw: json),
            "error" => new ProgressEvent(ProgressKind.Error, Message: (string?)json!["message"], Raw: json),
            _ => null,
        };
    }

    private static long Long(JsonNode? node) => node is JsonValue value && value.TryGetValue(out long number) ? number : 0;

    private static bool Bool(JsonNode? node) => node is JsonValue value && value.TryGetValue(out bool flag) && flag;
}
