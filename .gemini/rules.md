# D365 FnO MCP Server — Project Rules & Context

## Project Purpose
A **Model Context Protocol (MCP) server** for Microsoft Dynamics 365 Finance & Operations (D365 FnO),
targeting developers. Gives AI agents deep insight into **local AOT source code** — tables, classes,
enums, labels, cross-references — by indexing `PackagesLocalDirectory` XML files into SQLite.

> **No live D365 environment connection.** Pure local code intelligence tool.

## Tech Stack
- **Runtime**: Node.js 24, TypeScript (ESNext modules, strict mode)
- **MCP Transport**: HTTP Streamable SSE — MCP spec 2025-03-26 (`StreamableHTTPServerTransport`)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Local Indexing**: `PackagesLocalDirectory` AOT XML files -> parsed with `fast-xml-parser` -> stored in SQLite via Node's built-in SQLite driver
- **Auth (MCP clients)**: API Key via `X-API-Key` HTTP header
- **No live D365 connection**: No Azure AD, no OData, no network calls to D365
- **Distribution**: Local clone only — `git clone` → `npm install` → `npm start`

## Key Design Decisions
- Pure local tool — reads `PackagesLocalDirectory` XML only, no network calls to D365
- Single config point: `.env` file with `MCP_PORT`, `MCP_API_KEY`, `D365_PACKAGES_DIR`, `D365_INDEX_DB_PATH`
- SQLite index is incremental (file mtime-based, no full rebuilds)
- Cross-references enabled: `get_table_details` shows which classes/forms reference a table
- 9 MCP tools total: 7 metadata + 2 label

## File Structure
```
src/
  index.ts              # Entry point
  config.ts             # Zod env validation
  transport.ts          # HTTP/SSE + API key middleware
  indexer/
    scanner.ts          # AOT file discovery (glob)
    parser.ts           # XML parsing (fast-xml-parser)
    db.ts               # SQLite schema & queries
    buildIndex.ts       # Incremental index orchestrator
  tools/
    metadata.ts         # 7 AOT metadata tools
    labels.ts           # 2 label tools
tests/
.env.example
README.md
```

## D365 FnO AOT File Layout (PackagesLocalDirectory)
```
PackagesLocalDirectory/
  <PackageName>/
    <PackageName>/
      AxTable/          *.xml  → tables
      AxClass/          *.xml  → X++ classes
      AxEnum/           *.xml  → enums
      AxForm/           *.xml  → forms
      AxQuery/          *.xml  → queries
      AxDataEntityView/ *.xml  → data entities
      AxLabelFile/      *.label.txt → labels
```

## Environment Variables (.env)
```
MCP_PORT=3000
MCP_API_KEY=<secret>
D365_PACKAGES_DIR=K:\\AosService\\PackagesLocalDirectory
D365_INDEX_DB_PATH=./d365_index.db
```

## Coding Conventions
- Use `zod` for all input validation (tool inputs + env vars)
- Use named exports (no default exports except in `index.ts`)
- Keep tool handlers thin — delegate to indexer/db modules
- All DB queries in `src/indexer/db.ts` (single source of truth)
- Log format: `[D365-MCP] <timestamp> <level> <message>`
- Errors thrown from tools should be user-friendly strings (MCP clients display them)

## References
- MCP Spec: https://spec.modelcontextprotocol.io/specification/2025-03-26/
- D365 OData: https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/odata
- D365 Metadata REST: https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/dev-tools/metadata-api
