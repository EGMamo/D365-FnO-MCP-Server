namespace D365FnoMcp.Core;

public static class ApiKeyEntry
{
    /// <summary>
    /// The key to use after the API key prompt: what was typed (trimmed), or the saved key
    /// when the prompt was left empty. Null when there is neither.
    /// </summary>
    public static string? Resolve(string? entered, string? savedKey)
    {
        string typed = entered?.Trim() ?? string.Empty;
        if (typed.Length > 0)
        {
            return typed;
        }

        return string.IsNullOrWhiteSpace(savedKey) ? null : savedKey;
    }
}
