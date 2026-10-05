using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility.Shell;

namespace D365FnoMcp.Extension;

/// <summary>The API key input box shared by Configure Connection, Set API Key and Test Connection.</summary>
internal static class ApiKeyPrompt
{
    /// <summary>Returns the key to use, or null when the user cancelled or left it empty with nothing saved.</summary>
    public static async Task<string?> AskAsync(ShellExtensibility shell, ISecretStore secrets, string serverUrl, CancellationToken cancellationToken)
    {
        string? savedKey = secrets.Read(SecretNames.ApiKey(serverUrl));
        string? entered = await shell.ShowPromptAsync(
            savedKey is null
                ? $"API key for {serverUrl}{Environment.NewLine}{Environment.NewLine}Paste your client key from the server's MCP_API_KEYS setting (the part after 'name='). It is stored in Windows Credential Manager, never in a file."
                : $"API key for {serverUrl}{Environment.NewLine}{Environment.NewLine}A key is already saved in Windows Credential Manager. Paste a new key to replace it, or leave this empty to keep it.",
            InputPromptOptions.Default with { Title = "D365 F&O MCP: API key" },
            cancellationToken);
        if (entered is null)
        {
            return null;
        }

        string? apiKey = ApiKeyEntry.Resolve(entered, savedKey);
        if (apiKey is null)
        {
            await shell.ShowPromptAsync("An API key is required.", PromptOptions.ErrorConfirm, cancellationToken);
        }

        return apiKey;
    }
}
