# D365 FnO MCP Server

A Model Context Protocol (MCP) server that gives AI coding assistants first-class access to a Dynamics 365 Finance & Operations codebase: AOT metadata search, label lookup, and grounded X++ code generation.

## Features

- **Metadata search** — search AOT objects, inspect table schemas, class hierarchies, method signatures, EDTs, enums, form data sources, and raw element XML.
- **Label lookup** — resolve label IDs and full-text search label files across packages.
- **X++ generators with grounding** — Chain of Command extensions, table/class extensions, plain classes, RunBase batch jobs, and SysOperation classes. Generators validate their inputs against the index and fail closed rather than emit code for objects that do not exist.
- **Dual MCP transport** — Streamable HTTP (API-key protected) for remote/shared use, and stdio for local clients such as Claude Desktop, Claude Code, or VS Code.
- **SQLite index** — a local, incrementally updated index of `PackagesLocalDirectory`, so lookups are fast and offline.
- **CLI** — `setup`, `doctor`, `index`, and `serve` commands for a scripted, one-command onboarding.

## Prerequisites

- Node.js **22 or higher**
- A local D365 FnO `PackagesLocalDirectory` (or a copy of it)

## Installation

From a clone:

```bash
npm install
npm run build
npm link          # exposes the `d365-fno-mcp-server` binary globally
```

Alternatively, install the local checkout globally:

```bash
npm install -g .
```

The package is not published to npm yet, so `npx d365-fno-mcp-server` is not available.

## Quick start

```bash
d365-fno-mcp-server setup     # interactively creates a .env file (generates an API key)
d365-fno-mcp-server doctor    # validates config, packages dir, and DB access
d365-fno-mcp-server index     # builds the SQLite index (first run takes a while)
d365-fno-mcp-server serve     # starts the MCP server
```

Non-interactive setup, for scripts and CI:

```bash
d365-fno-mcp-server setup --non-interactive \
  --packages-dir "K:/AosService/PackagesLocalDirectory" \
  --api-key "$(openssl rand -hex 32)" \
  --db-path ./d365_index.db \
  --transport http
```

## Configuration

Configuration comes from environment variables (a `.env` file in the working directory is loaded automatically). Validation is strict: an invalid value aborts startup with a descriptive error.

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `http` | Transport to serve on: `http` or `stdio`. |
| `MCP_PORT` | `3000` | HTTP listen port (HTTP transport only). |
| `MCP_API_KEY` | _(required)_ | API key for HTTP authentication. Must be **at least 32 characters**. Still required in stdio mode for config validation. |
| `D365_PACKAGES_DIR` | _(required)_ | Path to `PackagesLocalDirectory`. |
| `D365_INDEX_DB_PATH` | `./d365_index.db` | Location of the SQLite index file. |
| `D365_INDEX_ON_START` | `0` | Set to `1` to run a background indexing pass on startup (also enables indexing on start in stdio mode). |
| `D365_BYPASS_PRUNE_GUARD` | `0` | Set to `1` to skip the "scan must overlap at least half of the previously indexed objects" prune guard. The zero-scan and parse-error guards still apply. Use only for an intentional large deletion. |
| `RATE_LIMIT_MAX_REQUESTS` | `500` | Max requests per client IP per rate-limit window. |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds (15 minutes). |
| `MCP_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout in milliseconds. |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops. `0` ignores `X-Forwarded-For`; set this to the real hop count **only** when behind a trusted proxy. |
| `MAX_CONCURRENT_SESSIONS` | `100` | Max simultaneous MCP sessions; further sessions receive HTTP `503`. |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions are closed after this period (swept every 60s). |

See `.env.example` for a starting point.

## CLI reference

```
d365-fno-mcp-server <command> [options]

Commands:
  serve                     Start the MCP server (default command)
  index [--force]           Run a foreground indexing pass
  doctor                    Validate environment and report issues (exit 1 on failure)
  setup [--non-interactive] Create a .env configuration file
      --packages-dir <dir>  D365 PackagesLocalDirectory path
      --api-key <key>       MCP API key (>= 32 chars; generated when omitted)
      --db-path <path>      SQLite index path (default ./d365_index.db)
      --transport <mode>    http or stdio (default http)

Options:
  -h, --help                Show help
  -v, --version             Show version
```

Flags accept `--flag`, `--flag=value`, and `--flag value` forms.

## Transport modes

### HTTP (default, `MCP_TRANSPORT=http`)

Streamable HTTP endpoint at `http://localhost:3000/mcp`. Every request must present the API key as either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

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

Health check (no auth): `GET http://localhost:3000/health` → `{ "status": "ok", "version": "0.1.0" }`.

### stdio (`MCP_TRANSPORT=stdio`)

For local MCP clients such as Claude Desktop, Claude Code, or VS Code. Logs are written to stderr so stdout stays reserved for JSON-RPC framing.

```json
{
  "mcpServers": {
    "d365-fno": {
      "command": "d365-fno-mcp-server",
      "args": ["serve"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MCP_API_KEY": "unused-in-stdio-but-required-min-32-characters",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory"
      }
    }
  }
}
```

In stdio mode, background indexing is skipped unless `D365_INDEX_ON_START=1`.

## Indexing

`d365-fno-mcp-server index` scans `D365_PACKAGES_DIR` and populates the SQLite index.

- **Incremental by default** — files whose path and modification time are unchanged since the last pass are skipped, so re-indexing after a sync is fast.
- **`--force`** — ignores mtimes and re-parses every file. Use after upgrading the server or when the index looks stale or corrupt.
- **Pruning** — entries whose source files no longer exist (deleted or renamed objects) are removed at the end of a full pass, along with their cross-references and labels.
- **Collisions** — when two files declare the same object name, the collision is counted and reported so duplicate/overlayed metadata is visible rather than silently overwritten.

Index statistics are also available at runtime through the `get_index_stats` tool.

## MCP tools

Metadata:
`search_symbols`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `find_references`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_element_xml`, `list_objects`, `get_index_stats`

Labels:
`resolve_label`, `search_labels`

X++ generators (grounded against the index):
`create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/ tests/
npm run build       # emits to dist/
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
```

## Security notes

- **API key** — `MCP_API_KEY` must be at least 32 characters; generate one with `openssl rand -hex 32`. It is compared on every HTTP request; the `/health` endpoint is the only unauthenticated route.
- **Rate limiting** — requests are limited per client IP (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`). Limiting is deliberately keyed on IP only, so rotating credentials cannot bypass the limit.
- **Trust proxy** — `TRUST_PROXY_HOPS` defaults to `0`, meaning `X-Forwarded-For` is ignored and the socket address is used. Only raise it when the server genuinely sits behind that many trusted proxies; otherwise clients can spoof their IP and evade rate limiting.
- **Session limits** — `MAX_CONCURRENT_SESSIONS` and `SESSION_IDLE_TIMEOUT_MS` bound memory use and clean up abandoned sessions.
- **Exposure** — the server grants read access to your source metadata and should not be exposed to untrusted networks. Prefer binding to localhost or fronting it with TLS.

## License

MIT — see [LICENSE](LICENSE).
