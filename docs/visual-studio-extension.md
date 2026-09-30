# Visual Studio extension

The **D365 F&O MCP** extension for Visual Studio 2022 (17.14+) and Visual Studio 2026 does two
things:

1. **Connection setup.** It asks for the server URL and API key, tests them, and writes the server
   into a `.mcp.json`. Copilot Chat and any other MCP client in Visual Studio (Claude models
   included) can then use the server's tools. This part is prompts only; it adds no custom UI.
2. **Index and upload.** It builds a new index from a `PackagesLocalDirectory` and the
   cross-reference database (`DYNAMICSXREFDB`), then uploads it to the server. You choose chunking
   and compression. Each chunk, and then the whole upload, is checked with a SHA-256 checksum
   before the server switches to the new index.

The extension adds an **Extensions > D365 F&O MCP** menu with five commands: **Configure
Connection...**, **Test Connection**, **Index and Upload...**, **Check Index Freshness** and
**Update Index**.

The source is in [`vs-extension/`](../vs-extension/README.md). It is an out-of-process
VisualStudio.Extensibility extension. Indexing and uploading are done by the
`d365-fno-mcp-server` CLI, which the extension runs and reports on.

## Requirements

| For | You need |
| --- | --- |
| Connection setup | Visual Studio 2022 17.14 or later, or Visual Studio 2026 |
| Index and upload | Node.js 24 and the CLI (`npm install -g .` in a checkout, after `npm install && npm run build`) |
| XRef import with Windows sign-in | `msnodesqlv8` where the CLI is installed (`npm install msnodesqlv8` in a checkout, `npm install -g msnodesqlv8` for a global install) and an ODBC driver for SQL Server (17 or 18) |
| XRef import with a SQL login | `npm install -g mssql` if the CLI was installed with `--omit=optional` |
| Uploading | A server of this version with `D365_INDEX_UPLOAD_KEYS` naming your key (see [Server setup](#server-setup)) |

Install the extension by double-clicking `D365FnoMcp.Extension.vsix`. CI builds it as the
`vs-extension-vsix` artifact; you can also build it yourself as described in
[`vs-extension/README.md`](../vs-extension/README.md).

## Configure Connection

1. Enter the server URL, for example `https://app-d365-mcp.azurewebsites.net`. A trailing `/mcp`
   is accepted and removed.
2. Enter your API key. Visual Studio's input prompt shows it as you type. It is stored in Windows
   Credential Manager under `D365FnoMcp:api-key:<url>` and is never written to the settings file.
   If a key is already saved, leave the prompt empty to keep it.
3. The connection is tested (see [Test Connection](#test-connection)). If the test fails, you can
   still save.
4. Choose where the server goes:

   | Choice | File | API key |
   | --- | --- | --- |
   | This solution | `.mcp.json` next to the `.sln`, can be committed | Visual Studio asks for it (`${input:d365-fno-api-key}`) |
   | My user profile (key asked by VS) | `%USERPROFILE%\.mcp.json` | Visual Studio asks for it |
   | My user profile (key saved in the file) | `%USERPROFILE%\.mcp.json` | Written into the `X-API-Key` header |

   Only the `d365-fno` entry and its input are added or replaced. Other servers and inputs are left
   alone, and a changed file is backed up to `.mcp.json.bak`. Comments in an existing file are not
   preserved.

The result looks like this:

```json
{
  "inputs": [
    { "id": "d365-fno-api-key", "type": "promptString", "description": "API key for the d365-fno MCP server", "password": true }
  ],
  "servers": {
    "d365-fno": {
      "type": "http",
      "url": "https://app-d365-mcp.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "${input:d365-fno-api-key}" }
    }
  }
}
```

Then open Copilot Chat, switch to **Agent** mode, open **Tools** and enable the `d365-fno` tools.
If the server log shows `Unauthorized request` while Visual Studio shows the server as failed, the
prompted header did not reach the server. Run the command again and choose *key saved in the file*.

The Output pane (**D365 F&O MCP**) also prints the matching `claude mcp add` command for Claude
Code.

## Test Connection

This command tests the saved URL and key the same way an MCP client would, and reports:

- **Health**: `GET /health` answers and reports the server version. A server that is still
  downloading its index answers only once it is ready.
- **API key** and **MCP**: `initialize` and `tools/list` succeed with the key, and the number of
  tools. The test session is closed afterwards.
- **Index**: `GET /admin/index` returns the object count, build time and source (`manifest`,
  `upload` or `local`) of the index the server is serving.
- **Upload**: whether this key may upload an index.

Plain `http` to another machine is flagged, because the key would travel unencrypted.

## Index and Upload

The window has three sections and a log.

**1. Index**

- **PackagesLocalDirectory**: *Detect* looks for
  `%LOCALAPPDATA%\Microsoft\Dynamics365\<version>\PackagesLocalDirectory` (unified developer
  experience, newest version first), then `K:\`, `C:\`, `J:\` and `I:\AosService\PackagesLocalDirectory`.
  *Browse...* lets you choose any folder.
- **Index database**: where the index is built. The default is
  `%LOCALAPPDATA%\D365FnoMcp\index\d365_index.db`.
- **Build a new index**: deletes that file first, so the index is built from scratch. When this is
  off, the existing file is updated incrementally, which is much faster after the first run.

**2. Cross-reference database**

- **SQL Server** and **Database**: `localhost` and `DYNAMICSXREFDB` by default. A named instance
  (`.\SQLEXPRESS`) or LocalDB (`(localdb)\MSSQLLocalDB`) also works.
- **Authentication**:
  - **Windows** signs in as you through ODBC. It needs `msnodesqlv8`, installed next to the CLI.
  - **SQL login** asks for the password once and keeps it in Credential Manager. Use
    *Password...* to change it.
- **Trust the server certificate**: needed for the self-signed certificate of a local development
  SQL Server.
- Clear **Import compiler cross-references** to skip this step. The server then keeps no usage data
  for `find_usages`.

**3. Upload**

| Option | Choices | Guidance |
| --- | --- | --- |
| Compression | gzip (default), Brotli, None | Brotli is usually 15–25% smaller than gzip and slower to compress. Use None only on a fast network. |
| Level | Fastest, Balanced (default), Smallest | gzip 1/6/9 and Brotli 1/5/9. *Smallest* costs a lot of CPU on a multi-GB index. |
| Split into chunks | on (default), 32 MiB | Keep this on for Azure App Service: its front end ends any request that takes longer than about 230 seconds, so a multi-GB single request fails. A failed chunk is resent on its own. |
| Parallel uploads | 4 | The number of chunks in flight at once. |
| Relative paths | on | Stores file paths relative to `PackagesLocalDirectory`, so tool results do not show this machine's folders. |

**Index and Upload** saves these choices and then runs three CLI steps, shown with a progress bar:

1. `index --packages-dir <folder> --db-path <file>`
2. `index-xref --db-path <file>`, with the connection string passed in `D365_XREF_CONNECTION_STRING`
3. `upload-index --server <url> --compression … --chunk-size … --progress json --stop-on-stdin-close`,
   with the API key passed in `D365_MCP_API_KEY`

Secrets are passed to the CLI only through environment variables, never as command-line arguments.
**Cancel** stops the running step. The upload step is asked to stop rather than killed: it
cancels the upload on the server (so the next run is not refused while the old one is still
"receiving") and deletes its staging copy, and is killed only if it has not stopped after 30
seconds. The index step is stopped at once; the next run finishes what it left.

### How the upload is verified

`upload-index` works in these steps:

1. **Snapshot.** Writes a compact copy of the index (`VACUUM INTO`) and checks it with
   `PRAGMA quick_check`.
2. **Compress.** Compresses the copy while computing two SHA-256 hashes: one of the database and
   one of the compressed package.
3. **Declare.** Sends `POST /admin/index/uploads` with the encoding, both sizes, both SHA-256s,
   the chunk size and the object count. The server refuses the upload if the key may not upload,
   if the package is too large, if there is not enough disk space for the package plus the
   decompressed database, or if another upload is running.
4. **Chunks.** Sends each chunk with `PUT …/chunks/<n>` and its own `X-Content-SHA256`. The server
   hashes the chunk as it writes it. A mismatch (HTTP 422), a network error or a 5xx response
   resends only that chunk, with backoff, up to 5 attempts.
5. **Complete.** `POST …/complete` starts the server's checks, and the client polls until they
   finish:
   - **transfer**: the SHA-256 and size of the assembled file equal the declared package;
   - **content**: the decompressed database's SHA-256 and size equal the declared database;
   - **database**: it opens as a D365 index with build metadata and the declared object count.
   - **schema**: it was built by this server's schema version or later, so older indexes that lack
     data this version serves (such as label ids) are refused.
6. **Checksum.** The client compares the SHA-256 the server computed with its own. The log shows
   both, and the window shows `SHA-256 verified: …`.

The server replaces nothing until all four checks pass. Then it closes open MCP sessions (clients
reconnect on their own), swaps the database in and serves it. A failed check leaves the old index
in place and reports the expected and actual values.

## Check Index Freshness

**Check Index Freshness** tells you whether the index the server serves still matches the
`PackagesLocalDirectory` on this machine. It uses the server, key, packages folder and index file
saved by **Configure Connection** and **Index and Upload**, so run Index and Upload once first. It
builds and uploads nothing. Progress shows in Visual Studio's background tasks, the answer in a
prompt, and the first 20 changed files in the **D365 F&O MCP** Output pane.

It runs `index-status --packages-dir <folder> --db-path <file> --server <url> --json` with the API
key in `D365_MCP_API_KEY`, which:

1. asks the server which index it serves (`GET /admin/index`: build time, object count, XRef import);
2. scans the packages folder the same way `index` does;
3. compares the two:
   - When the local index is the one the server serves (same build time) or newer, each file is
     compared with the path and modification time the local index recorded, the rule `index` uses
     to skip unchanged files. Added, changed and removed files are all counted.
   - Otherwise (no local index, or someone else uploaded a newer one), files modified after the
     server's index was built count as changed. Removed files cannot be seen this way.

The index is out of date when any file changed, when the local index is newer than the served
one (built but never uploaded), when the local index has a different XRef import than the served
one (imported after the last upload), or when the local index was built by an older version whose
schema lacks data this version stores. The prompt then offers **Update index**.

Changes in the XRef database are not detected: the prompt shows when the served XRef data was
imported, and Update Index re-imports it when the XRef option is on.

## Update Index

**Update Index** runs the same steps as Index and Upload with the saved settings, without opening
the window, and always updates the existing index file in place (**Build a new index** is ignored).
Only files that changed since the last run are parsed again, so an update after a few edits is much
faster than the first build. It uses the saved compression, chunking and XRef choices, and the
upload is verified the same way. Only one index run happens at a time: Update Index, the Index
and Upload window and Check Index Freshness each refuse to start while another one runs.

## Server setup

| Variable | Default | Meaning |
| --- | --- | --- |
| `D365_INDEX_UPLOAD_KEYS` | _(empty: uploads off)_ | Comma-separated names from `MCP_API_KEYS` that may upload. Other keys get HTTP 403. |
| `D365_INDEX_UPLOAD_MAX_GB` | `50` | Largest package accepted. |
| `D365_INDEX_UPLOAD_MAX_CHUNK_MB` | `256` | Largest chunk accepted. |
| `D365_INDEX_UPLOAD_DIR` | `<index folder>/.uploads` | Scratch folder. It must be on the same volume as `D365_INDEX_DB_PATH`. |
| `D365_INDEX_PUBLISH_URL` | _(empty)_ | Container URL with a create+write SAS, e.g. `https://<account>.blob.core.windows.net/indexes?<sas>`. After a successful upload the server publishes the package there in the `publish-index` layout (the version folder first, `latest/manifest.json` last), so a restart downloads the same index. |

Disk space: during an upload the server holds the current index, the package and the decompressed
new database at the same time.

**On Azure App Service** the index lives on container-local disk, which is lost on restart. Set
`D365_INDEX_PUBLISH_URL` so an uploaded index survives restarts; the Bicep template does this with
the `indexUploadKeys` and `indexPublishSasUrl` parameters ([`infra/README.md`](../infra/README.md)).
Without it, the next restart downloads whatever `latest/manifest.json` points at. Uploads and the
scheduled `publish-index.ps1` both write `latest/manifest.json`, and the last one to finish wins.

**On a VM or a local server** the uploaded index stays at `D365_INDEX_DB_PATH`, together with
`<db>.manifest.json` recording `source: "upload"`. `get_index_staleness` then reports the snapshot
build time instead of scanning files that are not on the server. A hosted server that also has
`D365_INDEX_URL` keeps an uploaded index across restarts as long as its build time is newer than
the published one.

## Where things are stored

| What | Where |
| --- | --- |
| Settings (URL, folders, options) | `%LOCALAPPDATA%\D365FnoMcp\settings.json` |
| API key, SQL password | Windows Credential Manager, `D365FnoMcp:*` generic credentials |
| Index built by the extension | `%LOCALAPPDATA%\D365FnoMcp\index\d365_index.db` (configurable) |
| Log | The Index and Upload window, and the **D365 F&O MCP** Output pane (also Check Index Freshness and Update Index) |

The CLI runs `node <package>/dist/src/index.js` directly: it finds the package behind npm's
`d365-fno-mcp-server.cmd` shim on `PATH`. To use a checkout instead, set `"Cli"` in
`settings.json` to the repository folder or to its `dist/src/index.js`. Set `"Node"` to use a
specific `node.exe`. The XRef import with Windows sign-in uses `ODBC Driver 17 for SQL Server`; on
a machine with only Driver 18, set `"XrefOdbcDriver": "ODBC Driver 18 for SQL Server"`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| *The CLI 'd365-fno-mcp-server' was not found on PATH* | Install it globally, or set `"Cli"` in `settings.json`. |
| *Could not start 'node'* | Install Node.js 24, or set `"Node"` to the full path of `node.exe`. |
| *Windows authentication … needs the optional 'msnodesqlv8' driver* | Install `msnodesqlv8` where the CLI is installed (see [Requirements](#requirements)), or switch to a SQL login. |
| *SQL snapshot isolation is not enabled* | Ask the DBA to enable it on the XRef database, or run `index-xref --allow-source-locks` by hand. |
| *API key '…' is not allowed to upload* | Add the key's name to `D365_INDEX_UPLOAD_KEYS` and restart the server. |
| *Index uploads are disabled on this server* | `D365_INDEX_UPLOAD_KEYS` is empty. |
| HTTP 507 when the upload starts | The server's disk cannot hold the package plus the decompressed database. |
| HTTP 409 *Upload … is in progress* | Only one upload runs at a time. Wait for it, or (with the same key) `DELETE /admin/index/uploads/<id>`. |
| The upload fails after about 230 s on App Service | Turn chunking on, or use smaller chunks. |
| *transfer* or *content* check fails | The file was corrupted or changed during the upload; run it again. Nothing was replaced. |
| *live, but not persisted* | Blob publishing failed (for example, an expired SAS). The server serves the new index until it restarts; fix `D365_INDEX_PUBLISH_URL`. |
