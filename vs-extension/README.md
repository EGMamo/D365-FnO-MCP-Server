# D365 F&O MCP for Visual Studio

Source of the Visual Studio 2022 (17.14+) / Visual Studio 2026 extension. What it does and how to
use it: [docs/visual-studio-extension.md](../docs/visual-studio-extension.md).

| Project | Target | Contents |
| --- | --- | --- |
| `src/D365FnoMcp.Core` | `net8.0` | Settings, `.mcp.json` merging, the connection test, locating and running the CLI, the index/upload job and its JSON progress parsing, and the index freshness check. No Visual Studio references. |
| `src/D365FnoMcp.Extension` | `net8.0-windows8.0` | The out-of-process [VisualStudio.Extensibility](https://learn.microsoft.com/visualstudio/extensibility/visualstudio.extensibility/) extension: connection commands, loopback gateway lifecycle, workspace context, and Credential Manager storage. |
| `tests/D365FnoMcp.Core.Tests` | `net8.0` | xUnit tests for Core. `EndToEndTests` starts the repository's built server (`dist/`) and runs the real CLI through index and upload with gzip, Brotli and no compression, then checks freshness before and after an incremental update. They are skipped when `dist/` or Node.js is missing. |

## Build

```powershell
# From the repository root: the end-to-end tests use the built server.
npm ci
npm run build

cd vs-extension
dotnet test tests/D365FnoMcp.Core.Tests
dotnet build src/D365FnoMcp.Extension -c Release
```

On Windows the build writes `src/D365FnoMcp.Extension/bin/Release/net8.0-windows8.0/D365FnoMcp.Extension.vsix`.
Other operating systems compile the code and generate the extension metadata but do not package a
`.vsix`. CI builds the package on `windows-latest` and publishes it as the `vs-extension-vsix`
artifact.

To debug, open `D365FnoMcp.sln` in Visual Studio with the *Visual Studio extension development*
workload and press F5. This starts the experimental instance with the extension loaded.
