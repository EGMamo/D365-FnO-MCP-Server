namespace D365FnoMcp.Core.Tests;

/// <summary>
/// The Node gateway tests start real processes (the end-to-end one indexes with Node), which slows a
/// small CI runner enough for timing-sensitive gateway tests running beside them to time out. They
/// run on their own, after the parallel tests.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class NodeGatewayCollection
{
    public const string Name = "Node gateway processes";
}
