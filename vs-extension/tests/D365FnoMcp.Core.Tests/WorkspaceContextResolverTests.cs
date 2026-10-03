using D365FnoMcp.Core;

namespace D365FnoMcp.Core.Tests;

public class WorkspaceContextResolverTests
{
    [Fact]
    public void ResolvesSingleRnrProjectAndModelFromSolution()
    {
        string root = Directory.CreateTempSubdirectory().FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "src"));
            File.WriteAllText(
                Path.Combine(root, "Sales.sln"),
                """Project("{TYPE}") = "SalesProject", "src\SalesProject.rnrproj", "{PROJECT}" """);
            File.WriteAllText(
                Path.Combine(root, "src", "SalesProject.rnrproj"),
                """<Project><PropertyGroup><Model>SalesCustomizations</Model></PropertyGroup></Project>""");

            WorkspaceContext context = WorkspaceContextResolver.Resolve(root, "10.0.2095.13");

            Assert.Equal("10.0.2095.13", context.D365SdkVersion);
            Assert.Equal("Sales", context.Solution);
            Assert.Equal("SalesProject", context.Project);
            Assert.Equal("SalesCustomizations", context.Model);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LeavesProjectAndModelUnknownWhenSelectionIsAmbiguous()
    {
        string root = Directory.CreateTempSubdirectory().FullName;
        try
        {
            File.WriteAllText(
                Path.Combine(root, "Many.slnx"),
                """<Solution><Project Path="One.rnrproj" /><Project Path="Two.rnrproj" /></Solution>""");
            File.WriteAllText(Path.Combine(root, "One.rnrproj"), """<Project><Model>OneModel</Model></Project>""");
            File.WriteAllText(Path.Combine(root, "Two.rnrproj"), """<Project><Model>TwoModel</Model></Project>""");

            WorkspaceContext context = WorkspaceContextResolver.Resolve(root, null);

            Assert.Equal("Many", context.Solution);
            Assert.Null(context.Project);
            Assert.Null(context.Model);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DoesNotThrowForMissingWorkspace() =>
        Assert.Equal(
            new WorkspaceContext("10.0.1.2", null, null, null),
            WorkspaceContextResolver.Resolve(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")), "10.0.1.2"));
}
