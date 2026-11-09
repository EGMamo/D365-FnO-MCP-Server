# Installing the D365 F&O MCP Server (for AI agents)

These steps are for an AI agent (Cline, Claude Code, GitHub Copilot and others) that is installing this server for a user. Run them in order and ask the user for the paths they must supply.

## Requirements

- Node.js 24 or later (`node --version`).
- The folder with the user's custom models (`<Package>/<Model>/Ax<Type>/*.xml`). Ask the user for the path.
- For the standard application: the URL of a hosted server and a developer key from its operator. Without one,
  the gateway runs in local mode on the custom models alone. Full local indexes of `PackagesLocalDirectory` are no
  longer supported.

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

## 2. Local mode: custom models only

Ask the user which mode they want. Local mode needs no hosted server, URL or key:

```bash
d365-fno-mcp-server setup --non-interactive --mode local --custom-dir "<folder with the custom models>"
d365-fno-mcp-server doctor
d365-fno-mcp-server gateway
```

`gateway` indexes the custom models itself and prints a client entry for its loopback endpoint; register that.
Standard Microsoft objects are not known in this mode.

## 3. Hosted mode

The developer key comes from the operator of the hosted server (`d365-fno-mcp-server keys new <name>`); a
developer cannot create one. Configure the gateway as shown below, under "Hosted server plus your own custom
models".

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

Restart the client and call `local_index_status` (and, in hosted mode, `get_index_stats`). A `401` means the
key is missing or was revoked: ask the operator for a new one. If the gateway cannot start, run
`d365-fno-mcp-server doctor` with the same environment. If a hosted server cannot start, ask its operator to
check the artifact-store configuration and startup logs.

## Optional data

These imports feed extra tools. The server itself reads only its local index; `index-xref` and
`index-trace` read SQL Server and `index-release-plans` downloads a public feed.

- `index-xref`: compiler cross-references, for `find_usages`.
- `index-trace`: Trace Parser data, for the performance tools.
- `index-bp <Dynamics.AX.<Model>.xppbp.xml>`: compiler best-practice logs, for `get_bp_findings`.
- `index-release-plans`: Microsoft release plans.

See README.md for the flags each import takes.

Write tools are off by default. Leave `D365_ENABLE_WRITE_TOOLS` unset unless the user explicitly asks for them.
