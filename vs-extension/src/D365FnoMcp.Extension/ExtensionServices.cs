using System.Threading.Channels;
using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Documents;

namespace D365FnoMcp.Extension;

/// <summary>Shared state: settings file, secret store, HTTP client and the Output pane.</summary>
internal sealed class ExtensionServices : IDisposable
{
    private readonly VisualStudioExtensibility extensibility;
    private readonly SemaphoreSlim outputLock = new(1, 1);
    private readonly Channel<string> logQueue = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
    private OutputChannel? output;

    public ExtensionServices(VisualStudioExtensibility extensibility)
    {
        this.extensibility = extensibility;
        _ = Task.Run(this.DrainLogAsync);
    }

    public SettingsStore Settings { get; } = new(SettingsStore.DefaultPath());

    public ISecretStore Secrets { get; } = new CredentialManagerSecretStore();

    /// <summary>Long enough for a server that is still downloading its index to answer /health.</summary>
    public HttpClient Http { get; } = new() { Timeout = TimeSpan.FromSeconds(60) };

    /// <summary>One index run at a time: the Index and Upload window and Update Index share the index file.</summary>
    public SemaphoreSlim IndexJobLock { get; } = new(1, 1);

    public async Task WriteOutputAsync(string text, CancellationToken cancellationToken)
    {
        await this.outputLock.WaitAsync(cancellationToken);
        try
        {
            this.output ??= await this.extensibility.Views().Output.CreateOutputChannelAsync("D365 F&O MCP", cancellationToken);
            await this.output.Writer.WriteLineAsync(text);
        }
        finally
        {
            this.outputLock.Release();
        }
    }

    /// <summary>Queues a line for the Output pane; lines keep their order however many threads log.</summary>
    public void Log(string line) => this.logQueue.Writer.TryWrite(line);

    public void Dispose()
    {
        this.logQueue.Writer.TryComplete();
        this.output?.Dispose();
        this.Http.Dispose();
        this.outputLock.Dispose();
        this.IndexJobLock.Dispose();
    }

    private async Task DrainLogAsync()
    {
        await foreach (string line in this.logQueue.Reader.ReadAllAsync())
        {
            try
            {
                await this.WriteOutputAsync(line, CancellationToken.None);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // The Output pane is a copy of the window's log; losing a line there is harmless.
            }
        }
    }
}
