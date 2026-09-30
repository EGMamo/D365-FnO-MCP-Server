using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class CliRunnerTests
{
    [Theory]
    [InlineData("{\"ts\":\"t\",\"level\":\"INFO\",\"message\":\"Indexing progress\"}", false)]
    [InlineData("{\"ts\":\"t\",\"level\":\"DEBUG\",\"message\":\"x\"}", false)]
    [InlineData("{\"ts\":\"t\",\"level\":\"WARN\",\"message\":\"Collision\"}", true)]
    [InlineData("{\"ts\":\"t\",\"level\":\"ERROR\",\"message\":\"x\"}", true)]
    [InlineData("Error: something broke", true)]
    [InlineData("{not json", true)]
    public void FlagsOnlyWarningsAndPlainStderrAsProblems(string line, bool expected)
    {
        Assert.Equal(expected, CliRunner.IsProblemLine(line));
    }

    [Fact]
    public async Task CancelClosesStdinSoTheStepCanCleanUp()
    {
        // Stands in for `upload-index --stop-on-stdin-close`: cleans up and exits when stdin ends.
        const string script = "process.stdin.on('end', () => { console.log('cleaned up'); process.exit(3); }); process.stdin.resume(); console.log('ready');";
        var launch = new CliLaunch("node", new[] { "-e", script }, "node");
        var step = new CliStep("Upload", Array.Empty<string>(), new Dictionary<string, string>(), JsonProgress: false, StopsOnStdinClose: true);
        var lines = new List<string>();
        using var cancellation = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CliRunner.RunAsync(
            launch,
            step,
            (line, _) =>
            {
                lock (lines)
                {
                    lines.Add(line);
                }

                if (line == "ready")
                {
                    cancellation.Cancel();
                }
            },
            cancellation.Token));

        Assert.Contains("cleaned up", lines);
    }
}
