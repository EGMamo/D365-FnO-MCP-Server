using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Commands;
using Microsoft.VisualStudio.Extensibility.Shell;
using Microsoft.VisualStudio.ProjectSystem.Query;

namespace D365FnoMcp.Extension.Commands;

/// <summary>
/// Asks for the hosted server URL and API key, tests them, then writes only the
/// extension-owned loopback gateway into .mcp.json.
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
        settings.ServerUrl = serverUrl;
        this.services.Settings.Save(settings);
        this.services.Secrets.Write(SecretNames.ApiKey(serverUrl), apiKey);

        McpGateway gateway;
        try
        {
            gateway = await this.services.RestartGatewayAsync(serverUrl, apiKey, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or InvalidOperationException)
        {
            await shell.ShowPromptAsync($"Could not start the local MCP gateway: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        var choices = new PromptOptions<TargetChoice>
        {
            Title = "Where should Visual Studio find the server?",
            DismissedReturns = TargetChoice.Cancel,
            DefaultChoiceIndex = 0,
        };
        if (solutionDirectory is not null)
        {
            choices.Choices.Add("This solution (.mcp.json next to the .sln)", TargetChoice.Solution);
        }

        choices.Choices.Add("My user profile", TargetChoice.UserPrompt);
        TargetChoice choice = await shell.ShowPromptAsync(
            $"Write the local '{settings.McpServerName}' gateway into which .mcp.json?{Environment.NewLine}{Environment.NewLine}" +
            "The hosted API key stays in Windows Credential Manager. The file contains only an ephemeral loopback bearer token.",
            choices,
            cancellationToken);
        switch (choice)
        {
            case TargetChoice.Solution:
                break;
            case TargetChoice.UserPrompt:
                break;
            default:
                return;
        }

        string path = choice == TargetChoice.Solution ? McpJsonFile.SolutionFilePath(solutionDirectory!) : McpJsonFile.UserFilePath();
        try
        {
            McpJsonFile.Write(path, settings.McpServerName, gateway.Endpoint!, gateway.BearerToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException or System.Text.Json.JsonException)
        {
            await shell.ShowPromptAsync($"Could not update {path}: {ex.Message}", PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        settings.McpConfigurationPath = path;
        this.services.Settings.Save(settings);

        await this.services.WriteOutputAsync(
            $"Wrote local gateway '{settings.McpServerName}' to {path}. Hosted credentials remain in Windows Credential Manager.",
            cancellationToken);
        await shell.ShowPromptAsync(
            $"Saved. The local '{settings.McpServerName}' gateway was written to{Environment.NewLine}{path}{Environment.NewLine}{Environment.NewLine}" +
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
