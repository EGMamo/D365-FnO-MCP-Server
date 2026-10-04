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

## 2. Build the local index

Use absolute paths. The first run takes several minutes on a full `PackagesLocalDirectory`.

```bash
d365-fno-mcp-server index --packages-dir "<PackagesLocalDirectory>" --db-path "<absolute path>/d365_index.db"
```

Then check the setup:

```bash
D365_PACKAGES_DIR="<PackagesLocalDirectory>" D365_INDEX_DB_PATH="<absolute path>/d365_index.db" d365-fno-mcp-server doctor
```

## 3. Run the local HTTP server (local-data setup)

Generate a key and start the authenticated server:

```bash
export MCP_API_KEYS="local=$(openssl rand -hex 32)"
MCP_HOST=127.0.0.1 D365_INDEX_DB_PATH="<absolute path>/d365_index.db" \
  d365-fno-mcp-server serve
```

Register `http://127.0.0.1:3000/mcp` in the client using the same key:

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "X-API-Key": "<the value after local=>"}
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

## 5. Verify

Restart the client and call `get_index_stats`. A local server reads the database from
`D365_INDEX_DB_PATH`; a hosted server reads the active validated bundle configured by
`D365_ARTIFACT_STORE_PATH`. If the hosted server cannot start, inspect its artifact-store mount and
startup logs rather than rerunning local indexing.

## Optional data

These imports feed extra tools. The server itself reads only its local index; `index-xref` and
`index-trace` read SQL Server and `index-release-plans` downloads a public feed.

- `index-xref`: compiler cross-references, for `find_usages`.
- `index-trace`: Trace Parser data, for the performance tools.
- `index-bp <Dynamics.AX.<Model>.xppbp.xml>`: compiler best-practice logs, for `get_bp_findings`.
- `index-release-plans`: Microsoft release plans.

See README.md for the flags each import takes.

Write tools are off by default. Leave `D365_ENABLE_WRITE_TOOLS` unset unless the user explicitly asks for them.
