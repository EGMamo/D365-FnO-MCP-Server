# Visual Studio extension

The extension gives Copilot one `d365-fno` MCP connection. That connection is a loopback gateway
owned by the extension, not a direct connection to Azure.

## Installing

The extension needs Visual Studio 2022 17.14 or later, or Visual Studio 2026.

1. Download `D365FnoMcp.Extension.vsix` from the
   [latest release](https://github.com/EGMamo/D365-FnO-MCP-Server/releases/latest). The release
   notes list its SHA-256 checksum.
2. Close Visual Studio and double-click the file to install it.
3. Start Visual Studio and open **Extensions > D365 F&O MCP > Configure Connection...**. It asks
   for the server URL, then in a second box for the API key: your client key from the server's
   `MCP_API_KEYS` setting (the part after `name=`).

To enter or replace only the key later, use **Extensions > D365 F&O MCP > Set API Key...**. It
tests the key, stores it in Windows Credential Manager and restarts the local gateway with it.

Once the connection test passes, Configure Connection shows the server's tools with a checkbox
each, plus the local `workspace_get_context`. Only checked tools are offered to Copilot; the
gateway also refuses calls to unchecked ones. To change the choice later, use **Extensions > D365
F&O MCP > Select Tools...**, which re-validates the connection, shows the same list and applies the
change to the running gateway without a restart. Copilot may keep its earlier tool list until you
refresh the tools in Copilot Chat. With every tool checked, tools the server adds later are offered
too; with a partial selection, new tools stay off until you check them.

To update, install a newer release the same way. Builds of unreleased commits are available as the
`vs-extension-vsix` artifact of each CI run. They keep the version in
`vs-extension/Directory.Build.props`, so uninstall a newer release before installing one.

### Releasing a version

The `Release VS extension` workflow builds the VSIX with the version stamped in and publishes it as
a GitHub release. Start it either way:

- push a tag: `git tag extension-v0.2.0` and `git push origin extension-v0.2.0`;
- or run the workflow on `master` from the Actions tab with version `0.2.0`, which creates the tag.

Versions are plain `major.minor.patch`, because Visual Studio rejects pre-release suffixes, and each
release needs a higher version than the last so Visual Studio treats it as an update. The tag prefix
is `extension-v`, not `v`, because `v*` tags deploy the API.

## Connection model

```text
Copilot in Visual Studio
        |
        | http://127.0.0.1:<random>/mcp
        | per-process bearer token
        v
Visual Studio extension gateway
        |-- local workspace tools
        |
        `-- paired MCP session over HTTPS
            X-API-Key from Windows Credential Manager
            X-D365-Client-Sdk-Version
                    |
                    v
              Azure MCP API
```

- The Azure URL and API key are entered through **Extensions > D365 F&O MCP > Configure
  Connection...**; **Set API Key...** changes only the key. The API key is stored in Windows
  Credential Manager (generic credential `D365FnoMcp:api-key:<server URL>`), never in a settings
  file. Visual Studio's extension prompts cannot mask input, so the key is visible while typed.
- The generated `.mcp.json` contains only a loopback URL and an ephemeral bearer token. It never
  contains the Azure URL or Azure key.
- Other MCP server entries and inputs in the file are preserved.
- **Test Connection** checks `/health`, performs MCP `initialize`, and lists hosted tools.
- The gateway forwards hosted tools, resources and prompts and adds
  `workspace_get_context`, limited to the tools selected in **Select Tools...** (stored as
  `AllowedTools` in `%LOCALAPPDATA%\D365FnoMcp\settings.json`; absent means all tools).

## Using the Node gateway

This repository also contains a Node gateway, `d365-fno-mcp-server gateway`, described in
[Hybrid gateway](hybrid-gateway.md). Like the extension's gateway it listens on loopback and forwards
the hosted tools, but it also indexes your custom models on your machine, so Copilot can see custom
tables, extensions and labels that the hosted index lacks. It is a separate process: it has its own
port (default 3101) and token, reads the hosted key from `D365_HOSTED_API_KEY` or
`D365_HOSTED_API_KEY_FILE` instead of Windows Credential Manager, and nothing in it reads the
extension's settings or credentials.

| | Extension gateway | Node gateway |
| --- | --- | --- |
| Hosted key | Windows Credential Manager | `D365_HOSTED_API_KEY` or `D365_HOSTED_API_KEY_FILE` |
| Port and token | Random port, token per process | `D365_GATEWAY_PORT` (3101), persistent token file or `D365_GATEWAY_TOKEN` |
| Custom code | Not indexed | Indexed locally, merged into the answers |
| Workspace tool | `workspace_get_context` | `get_visual_studio_workspace` (settings from the environment, as for `serve`) |
| Tool selection | **Select Tools...** | None: every hosted tool plus `local_index_status` |
| Runs on | Windows, inside Visual Studio | Any system with Node.js 24 |

**Instead of the extension's gateway.** Start the Node gateway and register it in `.mcp.json` next to
the solution under the name `d365-fno`, as [the gateway guide](hybrid-gateway.md#4-point-the-agent-at-the-gateway)
shows. Use one `d365-fno` entry in the file at a time. You then do without
`workspace_get_context`, **Select Tools...** and the Credential Manager storage.

**Alongside the extension.** Keep the extension for Visual Studio and run the Node gateway for other
clients on the same machine, such as Claude Code, Copilot CLI or VS Code. The two are independent
processes on different ports. The prebuilt [local agents](local-agents.md) expect the server name
`d365-fno`; under any other name they have no tools.

Pointing the extension's server URL at the Node gateway has not been tested and is not documented here.

## Workspace context

`workspace_get_context` currently returns:

```json
{
  "d365SdkVersion": "10.0.2095.13",
  "solution": null,
  "project": null,
  "model": null
}
```

The current foundation derives the SDK version from an installed Unified Developer Experience
`PackagesLocalDirectory`. This is only reliable when the local installation is unambiguous. The
planned in-process F&O bridge will resolve the configuration selected by Visual Studio, match it to
its local `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\*.json`, and use that configuration's
application version and `ReferencePackagesPaths`. It must never choose the newest JSON or newest
installed directory when side-by-side configurations exist.

Solution identity comes from Visual Studio Project Query. When the solution contains exactly one
`.rnrproj`, the extension reads its `Model` property and returns the unambiguous project/model pair.
With multiple F&O projects it returns `null` rather than guessing which project is active. Only the
four-part SDK version is forwarded; XPPConfig contents, local paths, environment URLs, database
names, and credentials remain local.

Authoritative active-project selection, metadata-provider reads and guarded writes require the
planned in-process F&O bridge. They remain unavailable until the bridge passes the Windows/UDE
compatibility proof; the gateway does not advertise unsupported write tools.

## Write safety contract

When local writes are enabled in a future bridge build, each mutation must:

1. resolve through installed F&O metadata/project services rather than constructing metadata paths;
2. produce a preview and a single-use token bound to workspace, model, SDK version and file hashes;
3. require confirmation in Visual Studio;
4. revalidate the token and hashes immediately before mutation;
5. validate the resulting metadata and project registration;
6. roll back or report incomplete rollback explicitly.

The gateway will not expose arbitrary filesystem writes, shell execution, build, deploy, database
synchronization or runtime security publication.

## Building

```powershell
dotnet restore vs-extension/D365FnoMcp.sln
dotnet test vs-extension/tests/D365FnoMcp.Core.Tests/D365FnoMcp.Core.Tests.csproj
dotnet build vs-extension/D365FnoMcp.sln -c Release
```

VSIX packaging requires Windows and Visual Studio 2022 17.14 or later. Core and gateway code compile
cross-platform; `VsixUtil.exe` makes the final packaging target Windows-only.
