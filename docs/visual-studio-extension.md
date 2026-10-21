# Visual Studio extension

The extension gives Copilot one `d365-fno` MCP connection. That connection is a loopback gateway
owned by the extension, not a direct connection to Azure. With a custom models folder set, the
extension also runs the Node hybrid gateway on this machine, so Copilot sees your custom code
merged with the hosted index (see [Custom models](#custom-models)).

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
- With a custom models folder set, the paired session goes to the Node hybrid gateway that the
  extension runs, and that gateway holds the session to Azure ([Custom models](#custom-models)).

## Custom models

The hosted index holds only standard and ISV metadata. To let Copilot see your own tables,
extensions, classes, labels and security objects, set **Extensions > D365 F&O MCP > Set Custom
Models Folder...** to the folder that holds your custom models (`<Package>/<Model>/Ax<Type>/` below
it, as in `PackagesLocalDirectory`). It also asks for your private name prefixes, for example
`Contoso,Fabrikam`. Leave the folder empty to turn this off again.

With a folder set, the extension starts the Node hybrid gateway described in
[Hybrid gateway](hybrid-gateway.md) as a child process and forwards to it instead of to Azure:

```text
Copilot in Visual Studio
        |
        | http://127.0.0.1:<random>/mcp, per-process bearer token
        v
Visual Studio extension gateway      tool selection, workspace_get_context
        |
        | http://127.0.0.1:<random>, second per-process token
        v
Node hybrid gateway (child process)  custom index in memory, merges, private prefixes
        |
        | HTTPS, X-API-Key from Windows Credential Manager
        v
Azure MCP API
```

- The Node gateway indexes the folder on this machine and keeps the index current as files change.
  The index lives in memory, so nothing is written to disk and each Visual Studio instance has its
  own. The first index happens before the gateway listens; a large folder can take a few minutes,
  and the Output pane says when it is ready.
- Its routing and privacy rules are those of [Hybrid gateway](hybrid-gateway.md#which-tools-go-where):
  custom objects are answered locally, search, labels, schemas, references and impact are merged,
  and the remaining tools are forwarded. Nothing read from your custom models is sent to Azure;
  a call whose arguments contain a private prefix is not sent at all.
- The hosted key and the Node gateway's token reach the child through its environment only, never
  its command line or a file. The child's working directory is
  `%LOCALAPPDATA%\D365FnoMcp\node-gateway`, so no `.env` file elsewhere is read.
- The command also asks for an optional standard index: a `d365_index.db` built with the server's
  `index` command over your `PackagesLocalDirectory`. With one, the tools the hosted server would
  answer alone (security paths, SoD checks, `diff_roles`, entity readiness, BP findings and the
  generators) run in the Node gateway over the standard and custom models together, and are not
  sent to Azure. The file is only read. See [Standard index](hybrid-gateway.md#standard-index).
- **Select Tools...** also lists `local_index_status`, the Node gateway's report on the custom index.
- If the Node gateway does not start (no Node.js, command not found, an invalid folder), the
  extension forwards to Azure as before and writes the reason to the **D365 F&O MCP** Output pane.
  If the Node gateway stops later, the next connection starts both gateways again.

The extension needs Node.js 24 or later and the server's CLI on the `PATH` (`npm link` in a clone of
this repository; the package is not on npm yet). To run it another way, set `NodeGatewayCommand` in
`%LOCALAPPDATA%\D365FnoMcp\settings.json`, for example
`"\"C:\\Program Files\\nodejs\\node.exe\" C:\\tools\\d365\\dist\\src\\index.js"`; the
extension appends `gateway`.

You can still run the Node gateway by hand for other clients on the same machine, such as Claude
Code, Copilot CLI or VS Code: it is a separate process with its own port and token (see
[Hybrid gateway](hybrid-gateway.md#4-point-the-agent-at-the-gateway)). The prebuilt
[local agents](local-agents.md) expect the server name `d365-fno`.

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
