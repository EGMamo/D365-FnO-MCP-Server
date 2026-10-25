# Installing the D365 F&O MCP Server (for AI agents)

These steps are for an AI agent (Cline, Claude Code, GitHub Copilot and others) that is installing this server for a user. Run them in order and ask the user for the paths they must supply.

## Requirements

- Node.js 24 or later (`node --version`).
- A Dynamics 365 Finance and Operations `PackagesLocalDirectory` or a copy of it. Ask the user for the path, for example `K:/AosService/PackagesLocalDirectory`.
- About 1–5 GB of free disk space for the SQLite index.

## 1. Build from source

The package is not on npm yet, so install it from a clone:

```bash
git clone https://github.com/EGMamo/D365-FnO-MCP-Server.git
cd D365-FnO-MCP-Server
npm install
npm run build
npm link
```

After `npm link`, the `d365-fno-mcp-server` command is on the PATH.

## 2. Configure and build the local index

Use absolute paths. Generate the API key yourself and pass it in: `setup` writes it to `.env` but never
prints a key it generated, so you could not register it in the client otherwise. `setup` writes the
`.env` file in the current directory (owner-only on macOS and Linux; on Windows it keeps the folder's
access rules, so keep that folder private); run every later command from that directory.

```bash
export API_KEY="$(openssl rand -hex 32)"
d365-fno-mcp-server setup --non-interactive \
  --packages-dir "<PackagesLocalDirectory>" \
  --api-key "$API_KEY" \
  --db-path "<absolute path>/d365_index.db" \
  --host 127.0.0.1
d365-fno-mcp-server doctor
d365-fno-mcp-server index
```

The `index` run takes several minutes on a full `PackagesLocalDirectory`. `doctor` should report `0 failed`
and end with a `Next:` line saying what to run.

## 3. Run the local HTTP server (local-data setup)

Start the authenticated server from the same directory (it reads `.env`):

```bash
d365-fno-mcp-server serve
```

It prints its URL and a client entry. Register `http://127.0.0.1:3000/mcp` in the client using the key from
step 2:

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "X-API-Key": "<the value of API_KEY>"}
    }
  }
}
```

Use this local setup for tools that depend on local-only imports such as `index-trace`.

## 4. Register a hosted HTTP server (alternative)

Add this to the client's MCP settings file:

- Cline: `cline_mcp_settings.json`
- Claude Desktop: `claude_desktop_config.json`
- VS Code: `.vscode/mcp.json` (see the VS Code form below)

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "<MCP_API_KEY>" }
    }
  }
}
```

VS Code uses a `servers` key:

```json
{
  "servers": {
    "d365-fno": {
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "<MCP_API_KEY>" }
    }
  }
}
```

### Hosted server plus your own custom models (gateway)

To search your custom models next to the hosted standard index, configure the local gateway instead of
registering the hosted server directly. Put the hosted key in a file (a key on the command line is
visible in the process list):

```bash
d365-fno-mcp-server setup --non-interactive --mode hosted \
  --hosted-url "https://<app>.azurewebsites.net/mcp" \
  --hosted-api-key-file "<absolute path to a file holding the hosted key>" \
  --custom-dir "<folder with the custom models>"
d365-fno-mcp-server doctor
d365-fno-mcp-server gateway
```

`gateway` prints a client entry for its loopback endpoint; register that in place of the hosted entry
(see `docs/hybrid-gateway.md`).

## 5. Verify

Restart the client and call `get_index_stats`. A local server reads the database from
`D365_INDEX_DB_PATH`; a hosted server reads the active validated bundle configured by
`D365_ARTIFACT_STORE_PATH`. A `401` means the key is missing or wrong. If a local server cannot
start, run `d365-fno-mcp-server doctor` with the same environment. If a hosted server cannot start,
ask its operator to check the artifact-store configuration and startup logs; rerunning local
indexing does not change a hosted server.

## Optional data

These imports feed extra tools. The server itself reads only its local index; `index-xref` and
`index-trace` read SQL Server and `index-release-plans` downloads a public feed.

- `index-xref`: compiler cross-references, for `find_usages`.
- `index-trace`: Trace Parser data, for the performance tools.
- `index-bp <Dynamics.AX.<Model>.xppbp.xml>`: compiler best-practice logs, for `get_bp_findings`.
- `index-release-plans`: Microsoft release plans.

See README.md for the flags each import takes.

Write tools are off by default. Leave `D365_ENABLE_WRITE_TOOLS` unset unless the user explicitly asks for them.
