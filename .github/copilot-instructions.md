# Copilot Instructions — D365 FnO MCP Server

Use this file as the default guidance when working in this repository.

## What this repo is

This is a **Model Context Protocol (MCP) server** for Microsoft Dynamics 365 Finance & Operations
(D365 FnO). It indexes `PackagesLocalDirectory` AOT XML into SQLite and exposes grounded metadata
and code-generation tools over **Streamable HTTP**.

It does **not** connect to a live D365 environment.

## Read first

- `AGENTS.md` (repo + agent guide)
- `README.md` (full feature list + config)
- `llms-install.md` (agent-friendly install steps)

## Repo structure

- `src/index.ts` is the CLI entry point.
- `src/server/` hosts the MCP transport and auth.
- `src/indexer/` builds/updates the SQLite index.
- `src/tools/` contains MCP tool handlers.
- `tests/` is `vitest`.

## Conventions

- Validate env vars and tool inputs with `zod`.
- Prefer named exports.
- Do not invent AOT names; resolve against the index.
- Do not enable write tools unless explicitly requested (`D365_ENABLE_WRITE_TOOLS=1`).
- If editing agent definitions, edit `agents/source/*` and run `npm run build:agents`.

## Commands

```bash
npm install
npm run build
npm test
```

