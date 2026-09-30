using System.Runtime.Serialization;
using D365FnoMcp.Core;
using Microsoft.VisualStudio.Extensibility;
using Microsoft.VisualStudio.Extensibility.Shell;
using Microsoft.VisualStudio.Extensibility.Shell.FileDialog;
using Microsoft.VisualStudio.Extensibility.UI;

namespace D365FnoMcp.Extension.IndexUpload;

/// <summary>
/// Data context of the Index and Upload window. Every choice is saved to the
/// settings file when a run starts; secrets come from Credential Manager.
/// </summary>
[DataContract]
internal sealed class IndexUploadViewModel : NotifyPropertyChangedObject, IIndexUploadObserver
{
    private const int MaxLogLines = 1000;
    private readonly VisualStudioExtensibility extensibility;
    private readonly ExtensionServices services;
    private readonly object logLock = new();
    private CancellationTokenSource? running;

    private string packagesDirectory;
    private string indexDbPath;
    private bool newIndex;
    private bool importXref;
    private string xrefServer;
    private string xrefDatabase;
    private int xrefAuthenticationIndex;
    private string xrefUser;
    private bool xrefTrustServerCertificate;
    private int compressionIndex;
    private int levelIndex;
    private bool useChunks;
    private int chunkSizeMb;
    private int parallelUploads;
    private bool relativePaths;
    private string serverUrl;
    private bool isRunning;
    private string status = "Ready.";
    private string stage = string.Empty;
    private double percent;
    private string checksum = string.Empty;

    public IndexUploadViewModel(VisualStudioExtensibility extensibility, ExtensionServices services)
    {
        this.extensibility = extensibility;
        this.services = services;
        ExtensionSettings settings = services.Settings.Load();
        this.serverUrl = settings.ServerUrl;
        this.packagesDirectory = string.IsNullOrEmpty(settings.PackagesDirectory) ? PackagesDirectoryLocator.Detect() ?? string.Empty : settings.PackagesDirectory;
        this.indexDbPath = settings.IndexDbPath;
        this.newIndex = settings.NewIndex;
        this.importXref = settings.ImportXref;
        this.xrefServer = settings.XrefServer;
        this.xrefDatabase = settings.XrefDatabase;
        this.xrefAuthenticationIndex = (int)settings.XrefAuthentication;
        this.xrefUser = settings.XrefUser;
        this.xrefTrustServerCertificate = settings.XrefTrustServerCertificate;
        this.compressionIndex = (int)settings.Compression;
        this.levelIndex = (int)settings.CompressionLevel;
        this.useChunks = settings.UseChunks;
        this.chunkSizeMb = settings.ChunkSizeMb;
        this.parallelUploads = settings.ParallelUploads;
        this.relativePaths = settings.RelativePaths;

        this.BrowsePackagesCommand = new AsyncCommand(this.BrowsePackagesAsync);
        this.DetectPackagesCommand = new AsyncCommand((_, _) =>
        {
            string? found = PackagesDirectoryLocator.Detect();
            if (found is null)
            {
                this.Status = "No PackagesLocalDirectory found; choose it with Browse.";
            }
            else
            {
                this.PackagesDirectory = found;
            }

            return Task.CompletedTask;
        });
        this.BrowseIndexCommand = new AsyncCommand(this.BrowseIndexAsync);
        this.SetSqlPasswordCommand = new AsyncCommand((_, ct) => this.PromptSqlPasswordAsync(ct));
        this.StartCommand = new AsyncCommand(this.StartAsync);
        this.CancelCommand = new AsyncCommand(async (_, _) =>
        {
            if (this.running is { } source)
            {
                await source.CancelAsync();
            }
        })
        { CanExecute = false };
    }

    [DataMember]
    public string ServerUrl { get => this.serverUrl; set => this.SetProperty(ref this.serverUrl, value); }

    [DataMember]
    public string PackagesDirectory { get => this.packagesDirectory; set => this.SetProperty(ref this.packagesDirectory, value); }

    [DataMember]
    public string IndexDbPath { get => this.indexDbPath; set => this.SetProperty(ref this.indexDbPath, value); }

    [DataMember]
    public bool NewIndex { get => this.newIndex; set => this.SetProperty(ref this.newIndex, value); }

    [DataMember]
    public bool ImportXref { get => this.importXref; set => this.SetProperty(ref this.importXref, value); }

    [DataMember]
    public string XrefServer { get => this.xrefServer; set => this.SetProperty(ref this.xrefServer, value); }

    [DataMember]
    public string XrefDatabase { get => this.xrefDatabase; set => this.SetProperty(ref this.xrefDatabase, value); }

    /// <summary>0 = Windows authentication, 1 = SQL login.</summary>
    [DataMember]
    public int XrefAuthenticationIndex
    {
        get => this.xrefAuthenticationIndex;
        set
        {
            if (this.SetProperty(ref this.xrefAuthenticationIndex, value))
            {
                this.RaiseNotifyPropertyChangedEvent(nameof(this.IsSqlLogin));
            }
        }
    }

    [DataMember]
    public bool IsSqlLogin => this.xrefAuthenticationIndex == (int)XrefAuthentication.SqlLogin;

    [DataMember]
    public string XrefUser { get => this.xrefUser; set => this.SetProperty(ref this.xrefUser, value); }

    [DataMember]
    public bool XrefTrustServerCertificate { get => this.xrefTrustServerCertificate; set => this.SetProperty(ref this.xrefTrustServerCertificate, value); }

    /// <summary>0 = gzip, 1 = brotli, 2 = none.</summary>
    [DataMember]
    public int CompressionIndex { get => this.compressionIndex; set => this.SetProperty(ref this.compressionIndex, value); }

    /// <summary>0 = fastest, 1 = balanced, 2 = smallest.</summary>
    [DataMember]
    public int LevelIndex { get => this.levelIndex; set => this.SetProperty(ref this.levelIndex, value); }

    [DataMember]
    public bool UseChunks { get => this.useChunks; set => this.SetProperty(ref this.useChunks, value); }

    [DataMember]
    public int ChunkSizeMb { get => this.chunkSizeMb; set => this.SetProperty(ref this.chunkSizeMb, value); }

    [DataMember]
    public int ParallelUploads { get => this.parallelUploads; set => this.SetProperty(ref this.parallelUploads, value); }

    [DataMember]
    public bool RelativePaths { get => this.relativePaths; set => this.SetProperty(ref this.relativePaths, value); }

    [DataMember]
    public bool IsRunning
    {
        get => this.isRunning;
        private set
        {
            if (this.SetProperty(ref this.isRunning, value))
            {
                this.RaiseNotifyPropertyChangedEvent(nameof(this.IsIdle));
            }
        }
    }

    [DataMember]
    public bool IsIdle => !this.isRunning;

    [DataMember]
    public string Status { get => this.status; private set => this.SetProperty(ref this.status, value); }

    [DataMember]
    public string Stage { get => this.stage; private set => this.SetProperty(ref this.stage, value); }

    [DataMember]
    public double Percent { get => this.percent; private set => this.SetProperty(ref this.percent, value); }

    [DataMember]
    public string Checksum { get => this.checksum; private set => this.SetProperty(ref this.checksum, value); }

    [DataMember]
    public ObservableList<string> LogLines { get; } = new();

    [DataMember]
    public AsyncCommand BrowsePackagesCommand { get; }

    [DataMember]
    public AsyncCommand DetectPackagesCommand { get; }

    [DataMember]
    public AsyncCommand BrowseIndexCommand { get; }

    [DataMember]
    public AsyncCommand SetSqlPasswordCommand { get; }

    [DataMember]
    public AsyncCommand StartCommand { get; }

    [DataMember]
    public AsyncCommand CancelCommand { get; }

    void IIndexUploadObserver.StepStarted(int index, int count, string name)
    {
        this.Status = $"Step {index + 1} of {count}: {name}";
        this.Stage = name;
        this.Percent = 0;
    }

    void IIndexUploadObserver.Log(string line, bool isError) => this.AppendLog(line, isError);

    void IIndexUploadObserver.Stage(string stageName, string message)
    {
        this.Stage = $"{stageName}: {message}";
        this.Percent = stageName == "done" ? 100 : 0;
    }

    void IIndexUploadObserver.Progress(string stageName, double value, long done, long total)
    {
        // Whole percents only: every update is a round trip to Visual Studio.
        double rounded = Math.Floor(value);
        if (rounded != this.Percent)
        {
            this.Percent = rounded;
            this.Stage = $"{stageName}: {FormatBytes(done)} of {FormatBytes(total)}";
        }
    }

    void IIndexUploadObserver.Check(string name, bool ok, string expected, string actual)
    {
        if (name == "checksum")
        {
            this.Checksum = ok ? $"SHA-256 verified: {actual}" : $"SHA-256 MISMATCH: {expected} / {actual}";
        }
    }

    private static string FormatBytes(long bytes) => bytes switch
    {
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KiB",
        < 1024L * 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MiB",
        _ => $"{bytes / (1024.0 * 1024 * 1024):F2} GiB",
    };

    private void AppendLog(string line, bool isError)
    {
        lock (this.logLock)
        {
            if (this.LogLines.Count >= MaxLogLines)
            {
                this.LogLines.RemoveAt(0);
            }

            this.LogLines.Add(isError ? $"! {line}" : line);
        }

        this.services.Log(line);
    }

    private async Task BrowsePackagesAsync(object? parameter, CancellationToken cancellationToken)
    {
        string? folder = await this.extensibility.Shell().ShowOpenFolderDialogAsync(
            new FolderDialogOptions { Title = "Choose PackagesLocalDirectory", InitialDirectory = Directory.Exists(this.PackagesDirectory) ? this.PackagesDirectory : string.Empty },
            cancellationToken);
        if (folder is not null)
        {
            this.PackagesDirectory = folder;
        }
    }

    private async Task BrowseIndexAsync(object? parameter, CancellationToken cancellationToken)
    {
        string? file = await this.extensibility.Shell().ShowSaveAsFileDialogAsync(
            new FileDialogOptions { Title = "Index database file", InitialFileName = Path.GetFileName(this.IndexDbPath) },
            cancellationToken);
        if (file is not null)
        {
            this.IndexDbPath = file;
        }
    }

    private async Task<string?> PromptSqlPasswordAsync(CancellationToken cancellationToken)
    {
        string? password = await this.extensibility.Shell().ShowPromptAsync(
            $"Password for SQL login '{this.XrefUser}' on {this.XrefServer} (stored in Windows Credential Manager):",
            InputPromptOptions.Default with { Title = "D365 F&O MCP" },
            cancellationToken);
        if (!string.IsNullOrEmpty(password))
        {
            this.services.Secrets.Write(SecretNames.XrefPassword(this.XrefServer, this.XrefDatabase, this.XrefUser), password);
        }

        return string.IsNullOrEmpty(password) ? null : password;
    }

    private ExtensionSettings Capture()
    {
        ExtensionSettings settings = this.services.Settings.Load();
        settings.PackagesDirectory = this.PackagesDirectory.Trim();
        settings.IndexDbPath = this.IndexDbPath.Trim();
        settings.NewIndex = this.NewIndex;
        settings.ImportXref = this.ImportXref;
        settings.XrefServer = this.XrefServer.Trim();
        settings.XrefDatabase = this.XrefDatabase.Trim();
        settings.XrefAuthentication = (XrefAuthentication)this.XrefAuthenticationIndex;
        settings.XrefUser = this.XrefUser.Trim();
        settings.XrefTrustServerCertificate = this.XrefTrustServerCertificate;
        settings.Compression = (UploadCompression)this.CompressionIndex;
        settings.CompressionLevel = (CompressionLevel)this.LevelIndex;
        settings.UseChunks = this.UseChunks;
        settings.ChunkSizeMb = this.ChunkSizeMb;
        settings.ParallelUploads = this.ParallelUploads;
        settings.RelativePaths = this.RelativePaths;
        return settings;
    }

    private async Task StartAsync(object? parameter, CancellationToken cancellationToken)
    {
        if (this.IsRunning)
        {
            return;
        }

        // Read every bound value before the first await so the run uses what was on screen.
        ExtensionSettings settings = this.Capture();
        this.ServerUrl = settings.ServerUrl;
        ShellExtensibility shell = this.extensibility.Shell();
        IReadOnlyList<string> problems = IndexJob.Validate(settings, Directory.Exists);
        if (problems.Count > 0)
        {
            await shell.ShowPromptAsync(string.Join(Environment.NewLine, problems), PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        this.services.Settings.Save(settings);
        string? apiKey = this.services.Secrets.Read(SecretNames.ApiKey(settings.ServerUrl));
        if (string.IsNullOrEmpty(apiKey))
        {
            await shell.ShowPromptAsync("No API key is saved for this server. Run Configure Connection first.", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        string? xrefPassword = null;
        if (settings.ImportXref && settings.XrefAuthentication == XrefAuthentication.SqlLogin)
        {
            xrefPassword = this.services.Secrets.Read(SecretNames.XrefPassword(settings.XrefServer, settings.XrefDatabase, settings.XrefUser))
                ?? await this.PromptSqlPasswordAsync(cancellationToken);
            if (xrefPassword is null)
            {
                return;
            }
        }

        if (settings.NewIndex && File.Exists(settings.IndexDbPath) &&
            !await shell.ShowPromptAsync($"Delete {settings.IndexDbPath} and build a new index?", PromptOptions.OKCancel, cancellationToken))
        {
            return;
        }

        CliLaunch launch;
        try
        {
            launch = new CliLocator().Resolve(settings.Cli, settings.Node);
        }
        catch (FileNotFoundException ex)
        {
            await shell.ShowPromptAsync(ex.Message, PromptOptions.ErrorConfirm, cancellationToken);
            return;
        }

        if (!await this.services.IndexJobLock.WaitAsync(0, cancellationToken))
        {
            await shell.ShowPromptAsync("An index run is already in progress (Update Index).", PromptOptions.AlertConfirm, cancellationToken);
            return;
        }

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        this.running = cancellation;
        this.IsRunning = true;
        this.StartCommand.CanExecute = false;
        this.CancelCommand.CanExecute = true;
        this.Checksum = string.Empty;
        lock (this.logLock)
        {
            this.LogLines.Clear();
        }

        IndexUploadResult result;
        try
        {
            result = await new IndexUploadRunner(launch).RunAsync(settings, new JobSecrets(apiKey, xrefPassword), this, cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            result = new IndexUploadResult(false, "Cancelled.");
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            result = new IndexUploadResult(false, ex.Message);
        }
        finally
        {
            this.services.IndexJobLock.Release();
            this.running = null;
            this.IsRunning = false;
            this.StartCommand.CanExecute = true;
            this.CancelCommand.CanExecute = false;
        }

        this.Status = result.Succeeded ? result.Message : $"Failed: {result.Message}";
        this.AppendLog(this.Status, !result.Succeeded);
    }
}
