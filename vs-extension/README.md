# D365 F&O MCP for Visual Studio

Source of the Visual Studio 2022 (17.14+) / Visual Studio 2026 extension. What it does and how to
use it: [docs/visual-studio-extension.md](../docs/visual-studio-extension.md).

| Project | Target | Contents |
| --- | --- | --- |
| `src/D365FnoMcp.Core` | `net8.0` | Settings, server URL validation, `.mcp.json` merging, the connection test, SDK version detection from `PackagesLocalDirectory`, the loopback MCP gateway, the `workspace_get_context` resolver, the `workspace_add_to_project` checks and the build log reader for `workspace_build_project`. No Visual Studio references. |
| `src/D365FnoMcp.Extension` | `net8.0-windows8.0` | The out-of-process [VisualStudio.Extensibility](https://learn.microsoft.com/visualstudio/extensibility/visualstudio.extensibility/) extension: *Configure Connection*, *Set API Key*, *Select Tools* and *Test Connection* commands, the tool picker dialog, loopback gateway lifecycle, workspace context, and Credential Manager storage. |
| `tests/D365FnoMcp.Core.Tests` | `net8.0` | xUnit tests for Core: connection test, gateway, `.mcp.json` merging, workspace context, settings, server URLs and SDK detection. They need neither Node.js nor the built server. |

## Build

```powershell
cd vs-extension
dotnet test tests/D365FnoMcp.Core.Tests
dotnet build src/D365FnoMcp.Extension -c Release
```

On Windows the build writes `src/D365FnoMcp.Extension/bin/Release/net8.0-windows8.0/D365FnoMcp.Extension.vsix`.
Other operating systems compile the code and generate the extension metadata but do not package a
`.vsix`. CI builds the package on `windows-latest` and publishes it as the `vs-extension-vsix`
artifact. Tagged versions are published as GitHub releases; see
[Installing](../docs/visual-studio-extension.md#installing) and
[Releasing a version](../docs/visual-studio-extension.md#releasing-a-version).

To debug, open `D365FnoMcp.sln` in Visual Studio with the *Visual Studio extension development*
workload and press F5. This starts the experimental instance with the extension loaded.
