# Visual Studio extension

The extension gives Copilot one `d365-fno` MCP connection. That connection is a loopback gateway
owned by the extension, not a direct connection to Azure.

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
  Connection...**. The API key is stored in Windows Credential Manager.
- The generated `.mcp.json` contains only a loopback URL and an ephemeral bearer token. It never
  contains the Azure URL or Azure key.
- Other MCP server entries and inputs in the file are preserved.
- **Test Connection** checks `/health`, performs MCP `initialize`, and lists hosted tools.
- The gateway forwards hosted tools, resources and prompts and adds
  `workspace_get_context`.

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
