using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;
using Microsoft.VisualStudio.ProjectSystem.Query;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Asks for the server URL and API key, tests them, and writes the server into
/// a .mcp.json so Copilot (or any MCP client in Visual Studio) can use it.
/// Prompts only: no custom UI.
/// </summary>
[VisualStudioContribution]
internal sealed class ConfigureConnectionCommand : Command
{
    private readonly ExtensionServices services;

    public ConfigureConnectionCommand(ExtensionServices services)
    {
        this.services = services;
    }

    public override CommandConfiguration CommandConfiguration => new("%D365FnoMcp.ConfigureConnection.DisplayName%")
    {
        Icon = new(ImageMoniker.KnownValues.ConnectToDatabase, IconSettings.IconAndText),
    };

    public override async Task ExecuteCommandAsync(IClientContext context, CancellationToken cancellationToken)
    {
        ShellExtensibility shell = this.Extensibility.Shell();
        ExtensionSettings settings = this.services.Settings.Load();

        string? url = await shell.ShowPromptAsync(
            "D365 F&O MCP server URL (for example https://app-d365-mcp.azurewebsites.net):",
            InputPromptOptions.Default with
            {
                Title = "D365 F&O MCP",
                DefaultText = string.IsNullOrEmpty(settings.ServerUrl) ? "https://" : settings.ServerUrl,
            },
            cancellationToken);
        if (url is null)
        {
            return;
        }

        string serverUrl;
        try
        {
            serverUrl = ServerUrl.Normalize(url);
        }
        catch (FormatException ex)
        {
            await shell.ShowPromptAsync(ex.Message, PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        string? savedKey = this.services.Secrets.Read(SecretNames.ApiKey(serverUrl));
        string? entered = await shell.ShowPromptAsync(
            savedKey is null
                ? "API key for this server (it is stored in Windows Credential Manager):"
                : "API key for this server. Leave empty to keep the saved key:",
            InputPromptOptions.Default with { Title = "D365 F&O MCP" },
            cancellationToken);
        if (entered is null)
        {
            return;
        }

        string apiKey = string.IsNullOrWhiteSpace(entered) ? savedKey ?? string.Empty : entered.Trim();
        if (apiKey.Length == 0)
        {
            await shell.ShowPromptAsync("An API key is required.", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        ConnectionReport report = await new ConnectionTester(this.services.Http).TestAsync(serverUrl, apiKey, cancellationToken);
        await this.services.WriteOutputAsync($"Connection test for {serverUrl}:{Environment.NewLine}{report.Summary()}", cancellationToken);
        if (!report.Succeeded &&
            !await shell.ShowPromptAsync($"The connection test failed:{Environment.NewLine}{Environment.NewLine}{report.Summary()}{Environment.NewLine}{Environment.NewLine}Save these settings anyway?", PromptOptions.OKCancel.WithCancelAsDefault(), cancellationToken))
        {
            return;
        }

        string? solutionDirectory = await this.GetSolutionDirectoryAsync(cancellationToken);
        var choices = new PromptOptions<TargetChoice>
        {
            Title = "Where should Visual Studio find the server?",
            DismissedReturns = TargetChoice.Cancel,
            DefaultChoiceIndex = 0,
        };
        if (solutionDirectory is not null)
        {
            choices.Choices.Add("This solution (.mcp.json next to the .sln, key asked by VS)", TargetChoice.Solution);
        }

        choices.Choices.Add("My user profile (key asked by VS)", TargetChoice.UserPrompt);
        choices.Choices.Add("My user profile (key saved in the file)", TargetChoice.UserKeyInFile);
        TargetChoice choice = await shell.ShowPromptAsync(
            $"Write the '{settings.McpServerName}' server into which .mcp.json?{Environment.NewLine}{Environment.NewLine}" +
            "A solution file can be committed and never contains the key. Choose 'key saved in the file' if Visual Studio does not pass a prompted key to the server.",
            choices,
            cancellationToken);
        McpJsonTarget target;
        switch (choice)
        {
            case TargetChoice.Solution:
                target = McpJsonTarget.SolutionPromptForKey;
                break;
            case TargetChoice.UserPrompt:
                target = McpJsonTarget.UserPromptForKey;
                break;
            case TargetChoice.UserKeyInFile:
                target = McpJsonTarget.UserKeyInFile;
                break;
            default:
                return;
        }

        string path = target == McpJsonTarget.SolutionPromptForKey ? McpJsonFile.SolutionFilePath(solutionDirectory!) : McpJsonFile.UserFilePath();
        try
        {
            McpJsonFile.Write(path, settings.McpServerName, serverUrl, target, apiKey);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            await shell.ShowPromptAsync($"Could not update {path}: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        settings.ServerUrl = serverUrl;
        this.services.Settings.Save(settings);
        this.services.Secrets.Write(SecretNames.ApiKey(serverUrl), apiKey);

        string next = target == McpJsonTarget.UserKeyInFile
            ? "Visual Studio uses the key from the file."
            : "Visual Studio asks for the API key the first time it starts the server.";
        await this.services.WriteOutputAsync(
            $"Wrote '{settings.McpServerName}' to {path}. {next}{Environment.NewLine}" +
            $"Claude Code: claude mcp add --transport http {settings.McpServerName} {ServerUrl.McpEndpoint(serverUrl)} --header \"X-API-Key: <key>\"",
            cancellationToken);
        await shell.ShowPromptAsync(
            $"Saved. '{settings.McpServerName}' was written to{Environment.NewLine}{path}{Environment.NewLine}{Environment.NewLine}{next} " +
            "In Copilot Chat, switch to Agent mode, open Tools and enable the d365-fno tools.",
            PromptOptions.InformationConfirm,
            cancellationToken);
    }

    /// <summary>Prompt results must be a non-nullable value type, so dismissal has its own value.</summary>
    private enum TargetChoice
    {
        Cancel,
        Solution,
        UserPrompt,
        UserKeyInFile,
    }

    private async Task<string?> GetSolutionDirectoryAsync(CancellationToken cancellationToken)
    {
        try
        {
            IQueryResults<ISolutionSnapshot> solutions = await this.Extensibility.Workspaces().QuerySolutionAsync(
                solution => solution.With(s => s.Directory),
                cancellationToken);
            string? directory = solutions.FirstOrDefault()?.Directory;
            return string.IsNullOrEmpty(directory) ? null : directory;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // No solution open, or the project system is not available.
            return null;
        }
    }
}
