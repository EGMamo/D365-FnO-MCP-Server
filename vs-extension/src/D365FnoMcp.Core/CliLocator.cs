namespace D365FnoMcp.Core;

/// <summary>How to start the d365-fno-mcp-server CLI.</summary>
public sealed record CliLaunch(string FileName, IReadOnlyList<string> PrefixArguments, string Description);

/// <summary>
/// Resolves the CLI to <c>node &lt;index.js&gt;</c> so arguments are passed to
/// Node directly instead of through the cmd.exe shim npm installs on Windows,
/// whose quoting breaks on paths with spaces, '&amp;' or '%'.
/// </summary>
public sealed class CliLocator
{
    private const string Entry = "dist/src/index.js";
    private readonly Func<string, bool> fileExists;
    private readonly Func<string, bool> directoryExists;
    private readonly string? pathVariable;

    public CliLocator(Func<string, bool>? fileExists = null, Func<string, bool>? directoryExists = null, string? pathVariable = null)
    {
        this.fileExists = fileExists ?? File.Exists;
        this.directoryExists = directoryExists ?? Directory.Exists;
        this.pathVariable = pathVariable ?? Environment.GetEnvironmentVariable("PATH");
    }

    public CliLaunch Resolve(string cli, string node)
    {
        string value = string.IsNullOrWhiteSpace(cli) ? "d365-fno-mcp-server" : cli.Trim().Trim('"');
        string nodeExe = string.IsNullOrWhiteSpace(node) ? "node" : node.Trim().Trim('"');

        if (value.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
        {
            return this.fileExists(value)
                ? new CliLaunch(nodeExe, new[] { value }, $"{nodeExe} {value}")
                : throw new FileNotFoundException($"The CLI script '{value}' does not exist.");
        }

        if (this.directoryExists(value))
        {
            // A repository checkout or an installed package folder.
            string script = Path.Combine(value, "dist", "src", "index.js");
            return this.fileExists(script)
                ? new CliLaunch(nodeExe, new[] { script }, $"{nodeExe} {script}")
                : throw new FileNotFoundException($"'{value}' has no {Entry}; run `npm run build` there.");
        }

        // A command on PATH: find npm's shim and the package next to it.
        foreach (string dir in (this.pathVariable ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (string candidate in new[] { value + ".cmd", value })
            {
                if (!this.fileExists(Path.Combine(dir, candidate)))
                {
                    continue;
                }

                string script = Path.Combine(dir, "node_modules", "d365-fno-mcp-server", "dist", "src", "index.js");
                if (this.fileExists(script))
                {
                    return new CliLaunch(nodeExe, new[] { script }, $"{nodeExe} {script}");
                }
            }
        }

        throw new FileNotFoundException(
            $"The CLI '{value}' was not found on PATH. Install it with `npm install -g d365-fno-mcp-server` " +
            "(or `npm install -g .` in a checkout), or set the CLI path to its dist/src/index.js.");
    }
}
