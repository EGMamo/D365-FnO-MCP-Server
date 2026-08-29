# D365 FnO MCP Server

An MCP server for Dynamics 365 Finance & Operations developers, providing tools to search AOT, get metadata, and generate X++ code.

## Prerequisites
- Node.js 22 or higher

## Setup

1. Clone repository
2. Copy `.env.example` to `.env` and set your `D365_PACKAGES_DIR` and `MCP_API_KEY`.
3. Install dependencies: `npm install`
4. Build project: `npm run build`
5. Start server: `npm start`

## Tools Provided
- search_symbols
- get_table_schema
- get_class_hierarchy
- get_method_signature
- find_references
- get_enum_values
- get_edt_details
- get_form_datasources
- get_element_xml
- list_objects
- get_index_stats
- resolve_label
- search_labels
- create_coc_extension
- create_table_extension
- create_class_extension
- generate_xpp_class
- create_runbase_batch
- create_sys_operation

## Client Config

The server supports two transports, selected with the `MCP_TRANSPORT` environment variable.

### HTTP (default, `MCP_TRANSPORT=http`)

Endpoint: `http://localhost:3000/mcp` (Streamable HTTP). Every request must carry the
API key, either as `X-API-Key: <key>` or `Authorization: Bearer <key>`.

```json
{
  "mcpServers": {
    "d365-fno": {
      "url": "http://localhost:3000/mcp",
      "headers": { "X-API-Key": "your-api-key" }
    }
  }
}
```

Health check (no auth required): `GET http://localhost:3000/health` → `{ "status": "ok", "version": "0.1.0" }`.

### stdio (`MCP_TRANSPORT=stdio`)

For local clients such as Claude Code or VS Code local MCP servers. Logs go to stderr so
stdout stays reserved for JSON-RPC.

```json
{
  "mcpServers": {
    "d365-fno": {
      "command": "node",
      "args": ["/path/to/D365-FnO-MCP-Server/dist/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MCP_API_KEY": "unused-in-stdio-but-required-min-32-characters",
        "D365_PACKAGES_DIR": "C:/AOSService/PackagesLocalDirectory"
      }
    }
  }
}
```

In stdio mode background indexing is skipped unless `D365_INDEX_ON_START=1` is set.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `MCP_PORT` | `3000` | HTTP listen port |
| `MCP_API_KEY` | _(required)_ | API key for HTTP auth (min 32 characters) |
| `D365_PACKAGES_DIR` | _(required)_ | PackagesLocalDirectory path |
| `D365_INDEX_DB_PATH` | `./d365_index.db` | SQLite index location |
| `D365_INDEX_ON_START` | `0` | Set to `1` to index on start in stdio mode |
| `RATE_LIMIT_MAX_REQUESTS` | `500` | Requests per window |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (15 min) |
| `MCP_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse-proxy hops. `0` ignores `X-Forwarded-For`; set to the real hop count only when behind a trusted proxy |
| `MAX_CONCURRENT_SESSIONS` | `100` | Max simultaneous MCP sessions; new sessions get `503` when full |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions are closed after this (swept every 60s) |
