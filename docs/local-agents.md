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
PackagesLocalDirectory (usually the development VM): `setup`, `doctor`, `index`, `serve`. You can
instead connect to a hosted API that serves an Azure-promoted index, or run the
[hybrid gateway](hybrid-gateway.md) in front of that hosted API so the agents also see your custom
models (see "Option: the hybrid gateway" below). The clients connect to the authenticated
Streamable HTTP endpoint; they do not launch a local server process.

## 2. Register the two MCP servers

Use exactly these server names: **`d365-fno`** and **`microsoft-learn`**. The agents' tool lists are
prefixed with them (`d365-fno/search_symbols`, `mcp__d365-fno__search_symbols`), so a different
name leaves an agent without tools. Point `d365-fno` at the server's `/mcp` URL:
`http://127.0.0.1:3000/mcp` for a local `serve` (default `MCP_PORT`), or the hosted HTTPS URL and
personal API key from your operator. The examples use the hosted form.

**VS Code**: `.vscode/mcp.json` in your X++ workspace. **Visual Studio**: `.mcp.json` next to the
solution, same shape.

```json
{
  "inputs": [
    {
      "id": "d365-mcp-api-key",
      "type": "promptString",
      "description": "D365 FnO MCP API key",
      "password": true
    }
  ],
  "servers": {
    "d365-fno": {
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "${input:d365-mcp-api-key}" }
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
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "${D365_MCP_API_KEY}" },
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
      "type": "http",
      "url": "https://<app>.azurewebsites.net/mcp",
      "headers": { "X-API-Key": "${D365_MCP_API_KEY}" }
    },
    "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp" }
  }
}
```

The agents work the same way against a local or [hosted server](hosted-deployment.md#client-connection),
but trace data is never on a hosted server.

### Option: the hybrid gateway

A hosted server knows only standard metadata, so an agent connected to it alone cannot see your
custom tables, extensions, Chain of Command classes or labels. The [hybrid gateway](hybrid-gateway.md)
runs on your machine, indexes your custom models into a separate local index, forwards every other
call to the hosted server and merges the two where both matter. Start it with `npm run gateway`
(see [Setup](hybrid-gateway.md#setup) for the variables) and register **the gateway** as `d365-fno`
instead of the hosted URL. The agents need no change: the gateway offers the hosted tools under the
same names, plus `local_index_status`.

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "http://127.0.0.1:3101/mcp",
      "headers": { "Authorization": "Bearer ${D365_GATEWAY_TOKEN}" }
    },
    "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp" }
  }
}
```

This is the Claude Code form. For VS Code, Visual Studio and Copilot CLI, use the shapes above with
the gateway's URL and `Authorization: Bearer <token>` in place of `X-API-Key`; the gateway prints
the VS Code and Visual Studio form when it starts, and [the gateway guide](hybrid-gateway.md#4-point-the-agent-at-the-gateway)
shows all four. The token is in `.d365/gateway-token` beside the local index unless you set
`D365_GATEWAY_TOKEN`. Keep one `d365-fno` entry in a client at a time.

The gateway indexes no trace data: the trace tools are forwarded to the hosted server, so trace
analysis is as limited as it is against any hosted server. Custom names that an agent puts into
tool arguments can reach the hosted server; read the gateway's
[privacy section](hybrid-gateway.md#privacy) and consider `D365_GATEWAY_PRIVATE_PREFIXES`.

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

Check the connection first: ask for `get_index_stats`. It should report your object counts, build
time and the application version the index describes (compare it with your local SDK). Through the gateway that is the hosted index's report; ask for `local_index_status` to
see the custom index and the hosted connection.

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
`apply_table_extension_change` to your own copy and start your local server with
`D365_ENABLE_WRITE_TOOLS=1`. A hosted server always refuses write tools.

See also: [Responsible AI and security FAQ](responsible-ai-faq.md).
