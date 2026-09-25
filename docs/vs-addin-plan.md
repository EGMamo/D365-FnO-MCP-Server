# Visual Studio add-in for applying MCP output

Status: proposal. Nothing in this document is implemented yet.

## Why

The hosted MCP server (see [hosted-deployment.md](hosted-deployment.md)) is
read-only by design. It answers questions and returns X++ and AOT XML, but the
things that make a write safe live inside Visual Studio: the open solution and
project, the Finance and Operations metadata provider, the compiler, and
database synchronization. Today a developer pastes generated code into the
project by hand. The add-in closes that gap: **preview** what the server
generated, **apply** it to the active model and project through the metadata
provider, and **build** so errors surface immediately.

Targets: Visual Studio 2022 (17.14+) and Visual Studio 2026, both with the
Finance and Operations development tools (unified developer experience or a
classic dev VM).

## What Microsoft supports, and what that decides

| Fact | Source | Consequence |
| --- | --- | --- |
| The F&O tools ship an **add-ins infrastructure**: a *Dynamics Developer Tools Add-in* project type; add-ins appear under **Dynamics 365 › Add-ins** and in the element designer's shortcut menu. | [Tools add-ins for Visual Studio](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/dev-tools/developer-tools-add-ins) | Build an **add-in**, not a stand-alone VSIX. It runs inside the F&O tools with the metadata provider and project system already loaded, and it gets a designer context menu for free. |
| A VS 2022 VSIX runs unchanged in VS 2026 when its install target is `[17.0,)`; only the lower bound is evaluated. | [Extension compatibility model](https://learn.microsoft.com/visualstudio/extensibility/migration/extension-compatibility) | One build for both versions. Add-ins are plain .NET Framework assemblies loaded by the F&O tools, so this applies to the optional VSIX wrapper only. |
| `Microsoft.Dynamics.AX.Metadata.MetaModel` (`AxClass`, `AxTableExtension`, `ModelSaveInfo`, …) and `Microsoft.Dynamics.AX.Metadata.Providers.IMetadataProvider` are public API. | [.NET API browser, dyn-finops-dotnet](https://learn.microsoft.com/dotnet/api/microsoft.dynamics.ax.xpp.metadatasupport.savetableextension?view=dyn-finops-dotnet) | Create elements as **objects** through the provider, which validates and serializes them, instead of writing XML files. |
| A project has a **Model** property (all elements must belong to it) and a **Synchronize database on build** property. | [Finance and operations project type](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/dev-tools/projects) | The add-in takes the target model from the selected project and can trigger DB sync by building with that property on. |
| The official MCP C# SDK is the `ModelContextProtocol` NuGet package. | [Get started with .NET AI and MCP](https://learn.microsoft.com/dotnet/ai/get-started-mcp) | Available, but see the dependency note below; a 200-line JSON-RPC client is the safer choice inside Visual Studio's process. |

## Architecture

```
Visual Studio 2022 / 2026 with F&O tools
┌───────────────────────────────────────────────────────────────────┐
│ Dynamics 365 › Add-ins › D365 MCP …          designer context menu │
│ ┌─────────────────────────┐   ┌──────────────────────────────────┐ │
│ │ D365Mcp.AddIn (net48)   │   │ D365Mcp.Core (netstandard2.0)    │ │
│ │ MEF exports:            │──►│ McpHttpClient  (JSON-RPC, SSE)   │ │
│ │  IMainMenuAddIn         │   │ ElementSpec models + validation  │ │
│ │  IDesignerMenuAddIn     │   │ Settings (URL, key name)          │ │
│ │ WPF preview dialog      │   └──────────────────────────────────┘ │
│ │ MetadataApplier         │──► IMetadataProvider.<Type>.Create(…)  │
│ │ ProjectApplier          │──► add element to the selected project │
│ │ BuildRunner             │──► DTE build (+ DB sync via property)  │
│ └─────────────────────────┘                                        │
└───────────────────────────────────────────────────────────────────┘
          │ HTTPS + X-API-Key (same key as .mcp.json)
          ▼
   hosted MCP server: generators return *structured* element specs
```

Two projects plus tests, in this repository under `vs-addin/`:

- **`D365Mcp.Core`** (`netstandard2.0`, no VS or F&O references): the MCP
  client, the element specification model, JSON parsing, settings, and the
  validation rules. Unit-tested on the existing Linux/Windows CI.
- **`D365Mcp.AddIn`** (`net48`, the runtime of in-process VS extensions):
  MEF exports for the two add-in interfaces, the WPF dialog, and the three
  appliers. References the F&O tools assemblies from the installed extension
  (`Private=false`); built on a machine that has the tools.
- **`D365Mcp.Core.Tests`** (xunit).

### Server contract: structured element specs

Generators today return free text. The add-in should not parse X++ or XML, so
each generator gains a `format: "structured"` option (or a companion
`plan_*` tool) returning a JSON **element spec** the add-in maps 1:1 onto
metadata objects:

```json
{
  "kind": "TableExtension",
  "name": "CustTable.Contoso",
  "model": null,
  "target": "CustTable",
  "fields": [{ "name": "ContosoRegion", "type": "String", "edt": "Name", "labelId": "@Contoso:Region", "mandatory": false }],
  "indexes": [],
  "fieldGroups": []
}
```

```json
{
  "kind": "Class",
  "name": "CustTableContoso_Extension",
  "declaration": "[ExtensionOf(tableStr(CustTable))]\nfinal class CustTableContoso_Extension\n{\n}",
  "methods": [{ "name": "validateWrite", "source": "public boolean validateWrite()\n{\n    boolean ret = next validateWrite();\n    return ret;\n}" }]
}
```

Kinds in scope: `Class` (covers Chain of Command, class extensions, plain
classes, RunBase, and each SysOperation class), `TableExtension`. The server
keeps grounding these against the index exactly as it does for the text
output, so the add-in never receives a spec for an object that does not exist.
The spec format is versioned (`"spec": 1`) and documented next to the manifest
format.

### Flow

1. **Generate**: the developer picks *Dynamics 365 › Add-ins › D365 MCP › Create
   table extension…* (or right-clicks a table in the designer). A small form
   collects the inputs; the add-in calls the server's generator with
   `format: "structured"`. Alternatively *Apply element from clipboard…*
   takes a spec that Copilot Chat produced from the same server.
2. **Preview**: a WPF dialog shows the target model (from the selected project),
   the element name, the fields/methods, and the generated source, plus every
   validation finding (name prefix rules, model membership, name collisions
   from `IMetadataProvider.<Type>.Exists`). Nothing has been written yet.
3. **Apply**: with the project saved, `MetadataApplier` builds the metadata
   objects and calls `IMetadataProvider.TableExtensions.Create(ext, new
   ModelSaveInfo(model))` / `Classes.Create(...)`; `ProjectApplier` adds the
   new element to the selected project; Application Explorer and Solution
   Explorer refresh.
4. **Build** (optional, on by default): `BuildRunner` builds the project
   through DTE. Errors appear in the Error List as usual. Database sync runs
   when the project's *Synchronize database on build* property is on; the
   dialog offers to turn it on for this build.

Safety rules carried over from the server's write tools: never overwrite an
existing element; refuse a model that is not the project's model; require the
project to be saved; one element per apply, with an undo hint (the created
element's path) in the output window.

### Authentication

The add-in stores the server URL and the API key in Visual Studio's credential
store (`IVsCredentialStorageService`), entered once in a settings dialog; the
same key the developer already uses in `.mcp.json`. The key is sent as
`X-API-Key`. Visual Studio's own `.mcp.json` inputs are not readable by
extensions, so they cannot be reused directly.

### MCP client

A minimal Streamable HTTP client in `D365Mcp.Core`: `initialize`,
`tools/list`, `tools/call`, the `Mcp-Session-Id` header, and parsing of both
JSON and `text/event-stream` responses. About 200 lines over `HttpClient` and
`System.Text.Json`. The `ModelContextProtocol` SDK is an alternative, but it
pulls `Microsoft.Extensions.*` packages whose versions collide with the copies
Visual Studio loads in-process; that class of conflict is the most common
cause of add-in load failures, so the hand-written client is the default.

## Milestones

Each is independently useful and mergeable.

**M0 – Spike (1–2 days, on a machine with the F&O tools).** Confirm the
assumptions marked *verify* below against the installed extension, using the
add-in project template. Produce a throwaway add-in that logs the selected
project's model and creates an empty class in it. This decides the exact
assembly references and the AddinExtensions path.

**M1 – Apply from spec.** `D365Mcp.Core` (spec model, validation, tests) and
`D365Mcp.AddIn` with *Apply element from clipboard…*: preview dialog, metadata
and project appliers, optional build. Server: `format: "structured"` on
`create_coc_extension`, `create_class_extension`, `generate_xpp_class`,
`create_table_extension`. Install script that copies the add-in into the
tools' AddinExtensions folder.

**M2 – Generate from Visual Studio.** MCP client, settings dialog, and the
*Create table extension… / Create Chain of Command extension… / Create
class…* commands that call the server directly. Designer context-menu entries
on tables and classes prefill the target.

**M3 – Round out.** RunBase and SysOperation (multi-class) specs, DB sync
option, "open element in designer after apply", telemetry-free error
reporting to the output window, and a VSIX wrapper if Marketplace
distribution is wanted (the VSIX would install the add-in files; it cannot
replace the AddinExtensions discovery mechanism).

## Repository layout

```
vs-addin/
  D365Mcp.sln
  Directory.Build.props        # D365ToolsPath detection, warnings-as-errors
  src/D365Mcp.Core/            # netstandard2.0
  src/D365Mcp.AddIn/           # net48, MEF exports, WPF
  tests/D365Mcp.Core.Tests/    # xunit, runs on CI
  scripts/install-addin.ps1    # copies build output into AddinExtensions
  README.md
```

CI: a Windows job runs `dotnet test vs-addin/tests/D365Mcp.Core.Tests`. The
add-in project is skipped on CI (`Condition="Exists('$(D365ToolsPath)')"`)
because the F&O assemblies are not redistributable; it builds on developer
machines and, later, on a self-hosted agent that has the tools installed.

## Assumptions to verify in M0

These come from the add-in template and from community add-ins, not from
Microsoft's reference docs, so the spike confirms them against the installed
version:

- The add-in contract: `Microsoft.Dynamics.Framework.Tools.Extensibility`
  `IMainMenuAddIn` / `IDesignerMenuAddIn` (`DisplayName`, `Description`,
  `OnClick(AddinEventArgs)`), exported through MEF, discovered from the tools'
  `AddinExtensions` folder. Confirm the folder location for the unified
  developer experience install (under the per-user Visual Studio extensions
  path) and for a dev VM.
- Access to the current provider and model:
  `DesignMetaModelService.Instance.CurrentMetadataProvider`,
  `ModelSaveInfo` construction from the project's model name, and
  `AxTableExtension` / `AxClass` construction (`Declaration`, `Methods`).
- Project integration: obtaining the active F&O project
  (`Microsoft.Dynamics.Framework.Tools.ProjectSystem`), and the API that adds
  an existing model element to it (the equivalent of Application Explorer's
  *Add to project*).
- Assembly loading: whether `Private=false` references resolve at runtime
  through the tools' binding paths, or the add-in needs an
  `AssemblyResolve` handler pointing at the extension folder.
- Which DTE command (if any) drives *Synchronize database*, versus relying on
  the project property.

## Out of scope

- Applying arbitrary XML files or overwriting existing elements.
- Deployment to an environment; the existing F&O tools remain authoritative
  for build, DB sync, and deploy.
- Replacing the server's write tools; they stay for the local, no-VS case.

## Effort

M0 about two days on a machine with the tools; M1 one to two weeks including
the server change and tests; M2 about a week; M3 as needed. M0 and the server
side of M1 can start now; everything in the add-in project needs a Windows
machine with Visual Studio and the F&O tools, which this cloud session does
not have.
