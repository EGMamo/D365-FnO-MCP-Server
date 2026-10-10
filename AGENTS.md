# D365 FnO MCP Server — Agent & Repo Guide

This repository is a **Model Context Protocol (MCP) server** that gives AI coding assistants
first-class, *grounded* access to a Microsoft Dynamics 365 Finance & Operations (D365 FnO)
codebase by indexing `PackagesLocalDirectory` AOT XML into a local SQLite database.

This file is intentionally **provider-agnostic**. It is meant to be usable by Codex, Claude,
Copilot, Gemini, Cursor, and any other LLM-based coding tool.

## What this repo does

- Builds an incremental SQLite index from D365 FnO AOT XML.
- Exposes MCP tools (over **Streamable HTTP**) to query that index.
- Optionally imports extra datasets (XRef, Trace Parser, BP logs, Microsoft release plans).
- Can run in "local" mode (developer-built index) or "hosted" mode (read-only artifact bundle).

**Important:** This project does **not** connect to a live D365 environment. It is a code
intelligence server. Generated KQL is produced as text; it is not executed.

## Quick start (developer)

```bash
npm install
npm run build

# interactive .env creation
npm run start -- setup

# validates config + DB access
npm run start -- doctor

# builds the SQLite index (first run can be minutes)
npm run start -- index

# runs the MCP server (Streamable HTTP)
npm run start -- serve
```

If you are an agent setting this up *for a user*, start with `llms-install.md`.

## Repo map

- `src/` — TypeScript source
  - `src/index.ts` — CLI entry point (`serve`, `index`, `doctor`, `setup`, etc.)
  - `src/server/` — MCP server startup, HTTP transport, API key auth, hosted artifact startup
  - `src/indexer/` — scanning/parsing AOT XML, DB schema, bundle building/imports
  - `src/tools/` — MCP tool handlers (metadata, labels, security, traces, generators, etc.)
  - `src/validation/` — grounding/resolution and input validation helpers
  - `src/workspace/` — Visual Studio workspace discovery + safe offline writes
- `tests/` — `vitest` test suite
- `docs/` — operator + user docs (hosted deployment, VS extension, local agents, etc.)
- `agents/` — **source-of-truth agent definitions**
  - Edit `agents/source/*` only; generated agent files live in `agents/github-copilot/*` and
    `agents/claude-code/*`.
- `infra/` — Azure infrastructure (Bicep) for hosted deployments

## Conventions (for contributors and agents)

- Validate tool inputs + environment with `zod`.
- Prefer named exports.
- Keep MCP tool handlers thin; put shared DB queries/index logic in `src/indexer/`.
- Do not invent AOT object names: always resolve against the index and report what was
  unresolved.
- Write tools are **off by default**; do not enable `D365_ENABLE_WRITE_TOOLS=1` unless explicitly
  requested.

## Build / lint / tests

```bash
npm run typecheck
npm run lint
npm test
```

If you change agent definitions under `agents/source/`, regenerate them:

```bash
npm run build:agents
```

## Key docs

- `README.md` — full feature list + configuration table
- `llms-install.md` — step-by-step install instructions written for agents
- `docs/user-and-admin-guide.md` — user + operator workflows
- `docs/hosted-deployment.md` — hosted-mode and artifact bundle model
- `docs/local-agents.md` — how to install/use the repo's prebuilt agents

