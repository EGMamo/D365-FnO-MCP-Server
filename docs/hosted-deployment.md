# Hosted deployment

Run the MCP server once, on Azure, and let every developer connect to it over
HTTPS with a personal API key. Nobody installs the server, builds an index or
keeps a multi-GB database locally. The Azure resources and the exact commands
are in [`infra/README.md`](../infra/README.md); this page explains how the
pieces fit, how the index gets there, and how clients connect.

## How it fits together

```
Publish machine (has PackagesLocalDirectory)             Azure
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│ scripts/publish-index.ps1 (scheduled)    │   │ Azure SQL: DynamicsXrefDB (BACPAC copy)      │
│  1. index          -> d365_index.db      │◄──┤   read-only login, snapshot isolation         │
│  2. index-xref     (Azure SQL)           │   ├──────────────────────────────────────────────┤
│  3. publish-index  -> <version>/ + latest│──►│ Blob Storage  indexes/<version>/d365_index.db.gz
│  4. az storage blob upload-batch          │   │               indexes/latest/manifest.json   │
│  5. az webapp restart                     │   ├──────────────────────────────────────────────┤
└──────────────────────────────────────────┘   │ App Service (Linux container, 1 instance)    │
                                               │  start: GET manifest -> download + verify    │
   Visual Studio / Claude Code / VS Code ──────►│  /mcp   X-API-Key   read-only tools          │
   HTTPS + X-API-Key                           │  /health                                     │
                                               └──────────────────────────────────────────────┘
```

- The **publish machine** is any machine with a `PackagesLocalDirectory`: a
  developer VM, or a unified development experience workstation
  (`%LOCALAPPDATA%\Microsoft\Dynamics365\<version>\PackagesLocalDirectory`).
  A scheduled task runs `scripts/publish-index.ps1` nightly.
- **`DynamicsXrefDB`** lives in Azure SQL so `index-xref` no longer needs a
  local SQL Server or LocalDB (which the `mssql` driver cannot reach with
  Windows authentication). The web app never talks to SQL.
- The **hosted server** starts by fetching `latest/manifest.json`, streaming
  the gzip database through a SHA-256 check into container-local disk, and
  opening it. It then serves the same read-only tools as a local server:
  search, schema, labels, references, usages, generators that return code.
  Write tools are off: the host has no Visual Studio workspace.
- A restart is the deployment mechanism. The publish script restarts the web
  app after uploading; the server re-downloads only when the manifest's
  checksum changed.

## Size the index before choosing a plan

Run a full `index` (raw XML on, the default) and `index-xref` on the publish
machine, then `publish-index`. Note the database size and the gzip size the
summary prints. App Service keeps the index on the container's local disk,
which has about 15 GB per instance shared with the image, so:

- up to a few GB: `P0v3` is enough; use `P1v3` above ~2 GB so the SQLite page
  cache fits in memory;
- above ~6–8 GB: reduce the index (`D365_INDEX_STORE_RAW_XML=0` plus
  `--allow-no-raw-xml`, at the cost of `get_element_xml`) or host on a VM.

## Publishing the index

`publish-index` writes:

```
<out>/<version>/d365_index.db.gz     compact copy (VACUUM INTO), gzip level 6
<out>/<version>/manifest.json        db.url = "d365_index.db.gz"
<out>/latest/manifest.json           db.url = "../<version>/d365_index.db.gz"
```

`version` is `<built_at as YYYYMMDDTHHMMSSZ>-<first 8 hex of the gzip sha256>`.
The manifest records the server version, build time, byte counts, object,
label and usage-row counts and the compiler usage import time:

```json
{
  "schema": 1,
  "version": "20260925T204420Z-3f9a1c2b",
  "serverVersion": "0.1.0",
  "builtAt": "2026-09-25T20:44:20.123Z",
  "publishedAt": "2026-09-26T01:00:00.000Z",
  "db": { "url": "../20260925T204420Z-3f9a1c2b/d365_index.db.gz", "sha256": "…", "bytes": 412345678, "rawBytes": 3456789012, "gzip": true },
  "stats": { "objects": 184320, "labels": 912004, "usageRows": 25731004 },
  "xref": { "importedAt": "2026-09-25T20:52:11.000Z" }
}
```

The script uploads the version folder first and `latest/manifest.json` last,
so a reader never follows a pointer to a half-uploaded version, and keeps the
newest `-Keep` versions for rollback (repoint `latest/manifest.json` at an
older folder and restart the app).

Options worth knowing:

- `--relative-paths` strips the packages directory from indexed file paths in
  the published copy, so tool results do not show the publish machine's
  folder layout.
- `publish-index` refuses an index built with `D365_INDEX_STORE_RAW_XML=0`
  unless `--allow-no-raw-xml` is given, because `get_element_xml` and the
  Chain of Command target check read raw XML on a host without source files.
- `pull-index --url <manifest-url>` downloads the published index to any
  machine, for example for a local server that needs the write tools.

## API keys

`MCP_API_KEYS` holds `name=key` pairs separated by commas or newlines; each
key must be at least 32 characters (`openssl rand -hex 32`). Give every person
or CI job its own name. The server logs the key **name** on each request and
binds each MCP session to the key that opened it; the key itself never appears
in logs. Rotating or revoking a key means updating the Key Vault secret and
restarting the web app.

Anyone holding a key can read all indexed metadata, so treat keys like
passwords. For a tighter perimeter, add App Service access restrictions
(allowed IP ranges) or virtual network integration. Visual Studio also
supports OAuth for remote MCP servers, so Microsoft Entra sign-in is a
possible later step.

## Connecting clients

Replace `<app>` with the web app name and `<key>` with your key.

### Visual Studio 2022 (17.14+) and Visual Studio 2026

Create `<SOLUTIONDIR>\.mcp.json` (shared through source control) or
`%USERPROFILE%\.mcp.json` (just for you):

```json
{
  "inputs": [
    {
      "id": "d365-mcp-api-key",
      "type": "promptString",
      "description": "D365 FnO MCP API key",
      "password": true
    }
  ],
  "servers": {
    "d365-fno": {
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "${input:d365-mcp-api-key}" }
    }
  }
}
```

Visual Studio prompts for the key the first time and keeps it out of the
file. Then open Copilot Chat in **Agent** mode, pick **Tools**, and enable the
`d365-fno` tools (they start disabled). If the server reports
`Unauthorized request` in its log while Visual Studio shows the server as
failed, the header did not reach it; put the key literally into the user-level
`%USERPROFILE%\.mcp.json` instead, or use the bridge below.

### Claude Code

```bash
claude mcp add --transport http d365-fno https://<app>.azurewebsites.net/mcp --header "X-API-Key: <key>"
```

Add `--scope user` to make it available in every project. `/mcp` shows the
connection and its tools.

### VS Code

`.vscode/mcp.json` uses the same shape as the Visual Studio file above
(`inputs` + `servers`). VS Code also prompts for the input on first use.

### Clients without header support

Bridge over stdio with `mcp-remote`, which forwards the header:

```json
{
  "mcpServers": {
    "d365-fno": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<app>.azurewebsites.net/mcp", "--header", "X-API-Key:${D365_MCP_API_KEY}"],
      "env": { "D365_MCP_API_KEY": "<key>" }
    }
  }
}
```

No space after the colon in `X-API-Key:`: some clients split arguments on
spaces.

### Check what you are talking to

Ask the assistant for `get_index_stats` (`builtAt`, object and label counts,
`usageSnapshot`) and `get_index_staleness`, which on a hosted server returns
`mode: "published"` with the version and build time instead of scanning
files.

## Operations

| Task | How |
| --- | --- |
| Refresh the index | The scheduled `publish-index.ps1`; or run it by hand |
| Roll back | Copy an older `<version>/manifest.json` over `latest/manifest.json` (fix `db.url` to `../<version>/…`) and restart the app |
| Add or revoke a key | New version of the `MCP-API-KEYS` secret, then restart |
| Rotate the SAS | New SAS, new version of `INDEX-SAS-URL`, restart; put the expiry in a calendar |
| Read logs | `az webapp log tail` or Log Analytics `AppServiceConsoleLogs` |
| Diagnose a restart loop | `d365-fno-mcp-server doctor --hosted` with the same `D365_INDEX_URL` |

Limits to keep in mind:

- **One instance.** MCP sessions live in process memory; scaling out would
  break them. Size `MAX_CONCURRENT_SESSIONS` for the team instead.
- **Restarts drop sessions.** Clients re-initialize automatically; a tool call
  in flight during the nightly restart fails once.
- **Idle connections close after ~4 minutes** at the App Service front end.
  The MCP client reconnects its event stream; tool calls are short SQLite
  reads and are unaffected.
- **Start-up takes as long as the download.** `/health` answers only once the
  index is ready; `WEBSITES_CONTAINER_START_TIME_LIMIT` is set to 30 minutes.

## Applying writes from Visual Studio

The hosted server returns X++ and XML (`create_coc_extension`,
`create_table_extension`, …) but never writes files. Applying a generated
element belongs in Visual Studio, where the metadata provider, compiler and
project system live. A Visual Studio extension that takes the server's output
and adds it to the open project is the intended next step; until then, paste
the generated code into the project, or run a local server with the write
tools enabled against a `pull-index` copy of the same index.
