# Claude Guide — D365 FnO MCP Server

If you're a coding agent working in this repo, start with:

- `AGENTS.md` (canonical repo + agent guide)
- `llms.txt` (short repo summary)
- `README.md` (full configuration and feature documentation)

## Key rules

- Validate env vars and tool inputs with `zod`.
- Do not invent AOT names; resolve everything against the index.
- Write tools are off by default; do not enable `D365_ENABLE_WRITE_TOOLS=1` unless explicitly
  requested.
- If editing agent definitions, edit `agents/source/*` only, then run `npm run build:agents`.

## Common commands

```bash
npm install
npm run build
npm test
```

