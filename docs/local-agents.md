# Local agents for GitHub Copilot and Claude Code

The repo ships four ready-made agents that run on your own machine. Each one uses this server's
tools and the Microsoft Learn MCP server:

| Agent | Use it for | Can edit files |
| --- | --- | --- |
| `xpp-developer` | Questions about the code base; drafting CoC, table/class extensions, SysOperation jobs, data entities; best-practice and field-access checks | Yes, after you agree |
| `performance-reviewer` | Analyzing Trace Parser captures imported with `index-trace` | No |
| `security-reviewer` | Roles, duties, privileges, access paths, segregation of duties, least-privilege drafts, converting Security configuration exports to AOT | No |
| `release-planner` | Release-wave features imported with `index-release-plans` and the customizations to retest | No |

The same agents come in two formats, generated from [`agents/source/`](../agents/source):

- GitHub Copilot custom agents: [`agents/github-copilot/*.agent.md`](../agents/github-copilot), for VS
  Code, Copilot CLI, and other IDEs that support custom agents.
- Claude Code subagents: [`agents/claude-code/*.md`](../agents/claude-code).

None of the agents can use `write_table_extension` or `apply_table_extension_change`.

## 1. Build the index

Follow the [Quick start](../README.md#quick-start) on the machine that has the
PackagesLocalDirectory (usually the development VM): `setup`, `doctor`, `index`. You can also
connect to the hosted API or use an Azure-promoted index. You don't need to run `serve`: the clients below
start the server themselves over stdio.

## 2. Register the two MCP servers

Use exactly these server names: **`d365-fno`** and **`microsoft-learn`**. The agents' tool lists are
prefixed with them (`d365-fno/search_symbols`, `mcp__d365-fno__search_symbols`), so a different
name leaves an agent without tools. Use absolute paths. Windows JSON needs forward slashes or
doubled backslashes.

**VS Code**: `.vscode/mcp.json` in your X++ workspace. **Visual Studio**: `.mcp.json` next to the
solution, same shape.

```json
{
  "servers": {
    "d365-fno": {
      "type": "stdio",
      "command": "d365-fno-mcp-server",
      "args": ["serve"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory",
        "D365_INDEX_DB_PATH": "C:/d365-mcp/d365_index.db"
      }
    },
    "microsoft-learn": {
      "type": "http",
      "url": "https://learn.microsoft.com/api/mcp"
    }
  }
}
```

**GitHub Copilot CLI**: `~/.copilot/mcp-config.json` (or `/mcp add` inside the CLI).

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "local",
      "command": "d365-fno-mcp-server",
      "args": ["serve"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory",
        "D365_INDEX_DB_PATH": "C:/d365-mcp/d365_index.db"
      },
      "tools": ["*"]
    },
    "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp", "tools": ["*"] }
  }
}
```

**Claude Code**: `.mcp.json` in the project root (shared with the team), or run
`claude mcp add` with `--scope user`.

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "stdio",
      "command": "d365-fno-mcp-server",
      "args": ["serve"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory",
        "D365_INDEX_DB_PATH": "C:/d365-mcp/d365_index.db"
      }
    },
    "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp" }
  }
}
```

If your team uses a [hosted server](hosted-deployment.md), register `d365-fno` as an HTTP server
with the `X-API-Key` header instead ([Connecting clients](hosted-deployment.md#connecting-clients)).
The agents work the same way, but trace data is never on a hosted server.

## 3. Copy the agents

| Client | Shared with the repo | Just for you |
| --- | --- | --- |
| VS Code, Copilot CLI | `.github/agents/` in your X++ repo | `~/.copilot/agents/` (CLI) or your VS Code user profile |
| Claude Code | `.claude/agents/` in your X++ repo | `~/.claude/agents/` |

```bash
# from a clone of this repo, into your X++ repo
cp agents/github-copilot/*.agent.md <xpp-repo>/.github/agents/
cp agents/claude-code/*.md          <xpp-repo>/.claude/agents/
```

On Windows, use `Copy-Item` with the same paths. After `npm install -g`, the files are also in the
package's `agents/` folder (`npm root -g` shows where).

If your Visual Studio version doesn't support custom agent files yet, paste the body of
`agents/source/xpp-developer.md` (the part after the front matter) into
`.github/copilot-instructions.md`.

## 4. Use them

- **VS Code**: open Chat, choose the agent from the agent picker, and ask. For example, "What
  extends SalesTable and who calls its validateWrite?"
- **Copilot CLI**: `/agent` picks an agent in a session. `copilot --agent security-reviewer -p
  "Which roles can post vendor invoices?"` runs one prompt.
- **Claude Code**: ask for the agent by name, for example "Use the performance-reviewer agent on the
  latest trace". Claude Code can also pick it from the description. `/agents` lists the agents,
  and `claude --agent xpp-developer` starts a whole session as that agent.

Check the connection first: ask for `get_index_stats`. It should report your object counts and
build time.

## Customize

Edit the files in `agents/source/`, then run `npm run build:agents` to regenerate both formats.
`npm test` fails if the generated files are out of date or an agent names a tool the server
doesn't have. Source front matter:

```text
---
name: my-agent                # lowercase-hyphenated; also the file name
description: One sentence.    # no double quotes
file-tools: read, search      # read, search, edit
d365-tools: search_symbols, get_table_schema
learn-tools: microsoft_docs_search
---
Instructions in Markdown.
```

Keep each agent's tool list short: the model picks tools more reliably from a focused set. To let
an agent write a table extension through the server, add `write_table_extension` and
`apply_table_extension_change` to your own copy and set `D365_ENABLE_WRITE_TOOLS=1` in the
`d365-fno` server's `env`. The server refuses this with a published index.

See also: [Responsible AI and security FAQ](responsible-ai-faq.md).
