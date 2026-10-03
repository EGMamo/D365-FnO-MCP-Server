# Responsible AI and security FAQ

Common questions from security reviewers, architects, and customers before they use this server
with an AI assistant. The format follows the FastTrack Compliance Advisor's FAQ. The answers
describe this code base. Your deployment choices, such as hosting, keys, and which optional data
you import, decide the rest.

## What is it?

An MCP (Model Context Protocol) server. It reads the Dynamics 365 Finance and Operations AOT
metadata files from a PackagesLocalDirectory, stores them in a local SQLite index, and exposes
read-only lookup tools to AI assistants such as GitHub Copilot, Claude Code, and Visual Studio. It does not contain or call a language model. The assistant that calls it decides which
tools to use and writes the answer.

## What is it for?

- Grounding AI answers and generated X++ in the objects that actually exist in the customer's code
  base: tables, classes, forms, entities, EDTs, enums, labels, security, and cross-references.
- Checks that help developers: entity OData readiness, security paths, segregation-of-duties
  conflicts, performance analysis of Trace Parser captures, and release-plan impact.
- Previews of generated X++ that developers review before adding them to a project.

It is not meant to make decisions without a human, change production systems, or replace testing,
code review, or security review.

## What data does it read and store?

| Data | Source | Stored where | Contains |
| --- | --- | --- | --- |
| AOT metadata and labels | XML files in PackagesLocalDirectory | Local SQLite index; production candidates are built by the private Azure worker | Source code and definitions. May contain comments or hard-coded values written by developers |
| XRef usages (optional) | `index-xref` from the DYNAMICSXREFDB database you choose | Same index | Cross-references between objects |
| Trace Parser captures (optional) | `index-trace` from a Trace Parser `AxTrace` database or a JSON export | Local index only | Method timings, SQL statements, user names, and session details |
| Release plans (optional) | `index-release-plans` from Microsoft's public release planner feed | Same index | Public Microsoft feature descriptions |

**Trace data is local by default.** The Azure worker must explicitly select which imports belong in
a production candidate; developer databases are never uploaded.

## Does it connect to Dynamics 365 or read business data?

No. The server never connects to a D365 environment, OData, Dataverse, SQL Server (except
XRef or Trace Parser databases when you run `index-xref` or `index-trace`), or Application Insights. `generate_kql_query` writes KQL for you
to run yourself. The server does not run it. Customer and transaction records are never read.

## What network calls does it make?

Only these, and only when you configure them:

- The private Azure acquisition worker downloading approved SDK assets and promoting an index.
- `index-release-plans`, which downloads Microsoft's public release planner feed. It runs only when
  you run that command.
- `index-xref` and `index-trace`, which read the SQL Server databases you point them at.

It sends no telemetry and doesn't call any other external service.

## Can the AI change code or systems through it?

By default, no. All tools are read-only. The generator tools (`create_*`, `generate_xpp_class`)
return **previews** as text. Writing files takes two steps and needs
`D365_ENABLE_WRITE_TOOLS=1` on a local server: `write_table_extension` prepares a preview and a
short-lived change ID, and `apply_table_extension_change` then writes the new table extension
into an existing model (and optionally adds it to the Visual Studio project). It refuses to
overwrite existing files. With write tools on, `digest_knowledge` can also add articles to the
knowledge base that every client of the server reads. A server running from a
published index refuses to enable them, so a hosted deployment is always read-only.

## Who can access it?

- **HTTP mode** (default): every request needs an API key (`X-API-Key` or `Authorization: Bearer`)
  of at least 32 characters from `MCP_API_KEYS` or `MCP_API_KEY`. Each MCP session is tied to the key that opened it. The
  server has rate limits, request timeouts, and a session limit.
- **HTTP mode**: only callers presenting a configured API key.

Anyone with a key can read everything in the index. Give keys only to people allowed to see the
code base, give each person, pipeline, or agent its own key name, and rotate keys like any other
secret.

## What is logged?

For each HTTP request: method, path, client IP, and the **name** of the API key. Session start and
end, rate-limit, and error events are logged too. API key values and tool arguments and results
are not logged. Your MCP client and AI service (GitHub Copilot, Claude) may keep their own
conversation logs under their own policies.

## How accurate are the results?

The index reflects the files at the time it was built. `get_index_staleness` shows when that was.
Lookups are exact. Some tools are heuristics, and their output says so:

- `check_feature_impact` matches release-plan keywords against object names and packages. It finds
  places to review, not confirmed breakages.
- `analyze_sod_conflicts` checks the duty pairs you give it against the security metadata. It does not
  know which users hold which roles in an environment.
- Trace analysis (`find_n_plus_one`, `find_slow_sql`) finds patterns in one capture. Always
  confirm with a new measurement.
- Generated X++ follows the index's field and method names but hasn't been compiled. Build it and
  run best-practice checks.

The assistant using the tools can still misread or ignore them. The
[local agents](local-agents.md) tell the assistant to look objects up before
using them, to say when something isn't found, and to label generated code as a preview.

## What should people check before relying on an answer?

- Object and field names in the answer match the code base (the assistant should name the tools
  it used).
- Generated code compiles, passes best-practice checks, and is reviewed by a developer.
- Security changes are tested in a non-production environment and approved by the security owner.
- Performance fixes are measured again after the change.

## Where are the limits?

- Metadata only. The server knows the code, not the data or the configuration of an environment.
- One index at a time, from one PackagesLocalDirectory or published version.
- Microsoft announced it would stop publishing the public release planner feed after September
  2026. If the feed is gone, `index-release-plans` fails and the last imported copy stays in the
  index; `--from-json` still imports a saved feed.

For hosting and key management, see [hosted-deployment.md](hosted-deployment.md) and the
[security notes](../README.md#security-notes) in the README.
