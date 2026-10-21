# Hybrid gateway

The gateway is a loopback MCP server for your agent that combines two indexes: the hosted server's
index of standard Microsoft and ISV metadata, and a second index of your own custom models that it
builds on your machine. The agent sees one `d365-fno` server. Your custom code is read from disk and
indexed locally; its contents are never sent to the hosted server (see [Privacy](#privacy) for what
is sent).

## Why

The hosted server serves an index that the Azure worker builds from the X++ SDK, so it knows only
standard metadata. It has no upload route, and custom code should not be sent to a shared server
anyway. An agent connected to the hosted server alone therefore cannot see your custom tables, table
extensions, Chain of Command classes, labels, security objects or the custom code that calls standard
objects.

The gateway closes that gap on the developer's machine: it indexes only the folder that holds your
custom models, answers questions about those objects itself, and merges its answers with the hosted
ones where both sides matter (search, labels, schemas, references, impact).

## Architecture

```text
Agent (Claude Code, Copilot, VS Code, Visual Studio)
        |
        | http://127.0.0.1:3101/mcp
        | Authorization: Bearer <gateway token>
        v
Hybrid gateway  (this machine; 127.0.0.1 only; Host allow-list)
        |
        |-- router: local-only | owner-routed | merged | forwarded
        |
        |-- local tool handlers --> custom index (SQLite, ./.d365/custom_index.db)
        |                                 ^
        |                                 | incremental re-index (file watcher + TTL)
        |                           D365_CUSTOM_METADATA_DIR  (your custom models)
        |
        `-- one hosted session per agent session
                |
                | HTTPS, X-API-Key, X-D365-Client-Sdk-Version
                v
        Hosted MCP server  (standard and ISV metadata index)
```

- The gateway reuses the server's HTTP transport (API-key check, sessions, rate limit, `/health`),
  so an agent talks to it exactly as it talks to `serve`.
- Every agent session opens its own session to the hosted server, so the hosted server keeps its
  per-agent state. The hosted tool list is shared and cached.
- The local tools are the same read-only handlers the server uses, run against the custom index.
  The gateway registers no write tools.

## Setup

You need Node.js 24 or higher, a build of this repo (`npm install`, `npm run build`), the hosted
server's URL and your personal API key from the operator, and the folder that holds your custom
models.

In Visual Studio you do not need the steps below: the extension's **Set Custom Models Folder...**
starts this gateway for you and keeps the hosted key in Windows Credential Manager (see
[Visual Studio extension](visual-studio-extension.md#custom-models)). Use the steps for other
clients such as Claude Code, Copilot CLI or VS Code.

### 1. Configure

Set these in the environment or in a `.env` file in the folder you start the gateway from (the same
`.env` loading as `serve`). They are also documented in [`.env.example`](../.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `D365_HOSTED_MCP_URL` | _(required)_ | Hosted MCP endpoint. Must be `https://`, except `http://` is accepted for `127.0.0.1`, `localhost` and `::1`. A URL without a path gets `/mcp` appended. No credentials in the URL. |
| `D365_HOSTED_API_KEY` or `D365_HOSTED_API_KEY_FILE` | _(one required)_ | Your hosted API key, sent as `X-API-Key`. Set exactly one. Prefer the file form: the file holds the key alone (surrounding whitespace is trimmed), which keeps it out of the environment and shell history. |
| `D365_CUSTOM_METADATA_DIR` | _(required)_ | Folder with your custom models, laid out as `<Package>/<Model>/Ax<Type>/*.xml`. It must exist. `D365_PROJECT_DIR` is accepted as a legacy fallback when this is empty. Point it at your own models only: standard models found there would be indexed locally and win over the hosted rows of the same name. |
| `D365_LOCAL_INDEX_DB_PATH` | `./.d365/custom_index.db` | SQLite file of the custom index, resolved to an absolute path from the folder you start the gateway in. `:memory:` is accepted (the index is then rebuilt on every start and a generated token is not kept). It must differ from `D365_INDEX_DB_PATH`; the main index is never touched. The token file lives in the same folder. |
| `D365_GATEWAY_PORT` | `3101` | Loopback port, 1 to 65535. The gateway always binds `127.0.0.1`. |
| `D365_GATEWAY_TOKEN` | _(generated)_ | Bearer token your agent presents. At least 32 characters, no whitespace, not a documentation placeholder; `openssl rand -hex 32` makes one. When unset, the gateway generates one and keeps it in a token file (see [Token](#3-start-and-find-the-token)). |
| `D365_APP_VERSION` | _(empty)_ | Four-part application version of your own `PackagesLocalDirectory`, e.g. `10.0.2645.136`. The gateway declares it to the hosted server in `X-D365-Client-Sdk-Version`, which tells the agent when its index describes a different application version (see [SDK version warnings](../README.md#sdk-version-warnings)). A version your agent's client declares itself takes precedence. A value that is not printable ASCII of 64 characters or fewer is not sent, with a warning. |
| `D365_GATEWAY_PRIVATE_PREFIXES` | _(empty)_ | Comma-separated name prefixes (for example your customer prefix) that must never be sent to the hosted server. See [Privacy](#privacy). |
| `D365_GATEWAY_UPSTREAM_TIMEOUT_MS` | `15000` | How long to wait for the hosted server before falling back to local results with a warning. 1000 to 120000. |
| `D365_GATEWAY_REINDEX_TTL_MS` | `30000` | Longest the custom index is served without a re-check, in case the file watcher misses a change. 1000 to 3600000. |
| `D365_VISUAL_STUDIO_WORKSPACE_DIR`, `D365_TARGET_SOLUTION`, `D365_TARGET_PROJECT`, `D365_TARGET_PACKAGE`, `D365_TARGET_MODEL` | _(empty)_ | Optional. Read by the local `get_visual_studio_workspace` tool exactly as `serve` reads them. |

An invalid value stops the gateway at startup with every problem listed. The messages never contain
the hosted key, the key file's path or the token. `MCP_LOG_LEVEL` sets the log level, as for `serve`.

Example `.env`:

```dotenv
D365_HOSTED_MCP_URL=https://<app>.azurewebsites.net/mcp
D365_HOSTED_API_KEY_FILE=C:\Users\me\.d365\hosted-api-key
D365_CUSTOM_METADATA_DIR=C:\Source\Metadata
D365_APP_VERSION=10.0.2645.136
D365_GATEWAY_PRIVATE_PREFIXES=Contoso
```

### 2. Check

```bash
npm run doctor
```

When `D365_HOSTED_MCP_URL` is set, `doctor` also validates the gateway settings, that the custom
folder is readable and holds metadata, that the local index path is writable, that the hosted server
answers `/health`, that the hosted key is accepted, and whether the hosted server's major and minor
version match the gateway's. It reports no key or token. On a machine that sets the hosted URL but
not `D365_PACKAGES_DIR`, the packages-folder, index and API-key checks of `serve` are skipped.

### 3. Start and find the token

```bash
npm run gateway
# the same as: node dist/src/index.js gateway
# or, after npm link: d365-fno-mcp-server gateway
```

The first start indexes the custom folder before the gateway listens, which takes longer for a
large code base; later starts re-read only files that changed. The gateway then contacts the hosted
server once to learn its instructions, version and tool list, and answers `503` until that attempt
has finished (an unreachable hosted server delays this by up to the upstream timeout; it is not
fatal). It prints the URL it listens on and a client entry for VS Code and Visual Studio to paste.

The token is never printed. Without `D365_GATEWAY_TOKEN` the gateway generates 32 random bytes (64 hex
characters) on first start, stores them in `gateway-token` in the folder of the local index
(`./.d365/gateway-token` by default) and reuses the file on every later start. To rotate the token,
delete the file and restart, or set `D365_GATEWAY_TOKEN`. Stop the gateway with Ctrl+C.

To run two gateways on one machine (two code bases), give each its own `D365_GATEWAY_PORT` and
`D365_LOCAL_INDEX_DB_PATH`; each keeps its token next to its own index.

### 4. Point the agent at the gateway

Register the gateway under the same name the hosted server uses, **`d365-fno`**, so the prebuilt
[local agents](local-agents.md) keep their tool prefixes. Use one `d365-fno` entry at a time: the
gateway replaces the hosted entry, it does not run beside it. Use `127.0.0.1` in the URL; the
gateway answers only to `127.0.0.1:<port>` and `localhost:<port>` (without the port for port 80,
which clients leave out).

**VS Code**: `.vscode/mcp.json`. **Visual Studio**: `.mcp.json` next to the solution, same shape.

```json
{
  "inputs": [
    {
      "id": "d365-gateway-token",
      "type": "promptString",
      "description": "D365 gateway token",
      "password": true
    }
  ],
  "servers": {
    "d365-fno": {
      "type": "http",
      "url": "http://127.0.0.1:3101/mcp",
      "headers": { "Authorization": "Bearer ${input:d365-gateway-token}" }
    },
    "microsoft-learn": {
      "type": "http",
      "url": "https://learn.microsoft.com/api/mcp"
    }
  }
}
```

**Claude Code**: `.mcp.json` in the project root. The file holds no secret; the token comes from the
environment of the shell that starts Claude Code.

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

```bash
export D365_GATEWAY_TOKEN="$(cat .d365/gateway-token)"      # PowerShell: $env:D365_GATEWAY_TOKEN = (Get-Content .d365\gateway-token).Trim()
```

**GitHub Copilot CLI**: `~/.copilot/mcp-config.json`, with the same `D365_GATEWAY_TOKEN` variable.

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "http://127.0.0.1:3101/mcp",
      "headers": { "Authorization": "Bearer ${D365_GATEWAY_TOKEN}" },
      "tools": ["*"]
    },
    "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp", "tools": ["*"] }
  }
}
```

The gateway also accepts the token as `X-API-Key: <token>`. If you set `D365_GATEWAY_TOKEN` in the
environment before starting the gateway, the same variable serves both sides.

### 5. Verify

Ask the agent to call `local_index_status`. It reports the custom index (`objects`, `labels`,
`lastRefreshAt`, `watcher`, `lastError`), whether the hosted server is reachable and its version,
and any merge tools that are forwarded because of a schema mismatch. Then try `get_index_stats`
(forwarded, so it describes the hosted index) and a `search_symbols` for one of your own objects; a
custom hit carries `"source": "local"`.

## Which tools go where

Every tool call takes one of four routes. The route names below are the lists exported by
`src/gateway/router.ts` (`LOCAL_ONLY_TOOL_NAMES`, `OWNER_ROUTED_TOOL_NAMES`, `MERGE_TOOL_NAMES`);
every other tool is forwarded.

- **Local-only**: answered from this machine, never sent upstream.
- **Owner-routed**: the tool names one object. If the custom index holds that object, the local tool
  answers and nothing is sent upstream; otherwise the call goes to the hosted server unchanged.
- **Merged**: the gateway asks the hosted server and runs the local logic, then combines both
  answers.
- **Forwarded**: sent to the hosted server unchanged, and its answer is returned unchanged.

For local-only, owner-routed and merged tools, the arguments are checked with the same zod rules as
the server's own tools before anything is sent upstream; an invalid call is rejected locally with
the usual "Input validation error". Forwarded tools are validated by the hosted server.

| Route | Tool | What the gateway does |
| --- | --- | --- |
| Local-only | `local_index_status` | Gateway-only tool: custom index counts and state, hosted reachability and version, skewed tools. Shows the custom folder by name only. |
| Local-only | `get_visual_studio_workspace` | Reads this machine's workspace settings. Listed even when the hosted server lacks it. |
| Owner-routed | `get_enum_values` | By `enumName` (Enum). |
| Owner-routed | `get_edt_details` | By `edtName` (Edt). |
| Owner-routed | `get_form_datasources` | By `formName` (Form). |
| Owner-routed | `get_query_datasources` | By `queryName` (Query). |
| Owner-routed | `get_data_entity_details` | By `entityName` (DataEntity). |
| Owner-routed | `get_method_signature` | By `className` (Class). |
| Owner-routed | `get_method_source` | By `objectName`, among the given `objectType` or Class, Table, Form and DataEntity. |
| Owner-routed | `get_element_xml` | By `name` and `type`. |
| Owner-routed | `get_security_object` | By `name` and `type` (Role, Duty or Privilege). |
| Owner-routed | `check_xpp_best_practices` | By `objectName`, among the given `objectType` or Class, Table, Form and DataEntity. With `source` it always runs locally and nothing is sent upstream. |
| Owner-routed | `create_coc_extension`, `create_class_extension` | By `targetClass` (Class, Table or Form). A custom target is drafted locally. |
| Owner-routed | `create_table_extension` | By `targetTable`. |
| Owner-routed | `create_event_handler` | By `targetName` among the given `targetType` or Table and Class. |
| Owner-routed | `create_form_event_handler` | By `formName`. |
| Merged | `search_symbols` | Local and hosted hits in one list, one row per type and name with the local row winning, ordered exact name, prefix, substring, other (the classes `explain` reports), local first within a class, then cut to `limit`. With `explain`, local rows get `match` and `explanation` too. |
| Merged | `list_objects` | One page from each side, sorted by type and name within the page. A `package` that the custom index holds is answered locally and not sent upstream. See [Known gaps](#known-gaps). |
| Merged | `list_packages`, `list_models` | Union by name, sorted by name. A name on both sides gets the sum of the two `objectCount` values and `source: "both"`. |
| Merged | `search_labels`, `search_labels_fts` | Local labels first, then hosted; one row per label id and language (language compared without regard to case) with the local row winning; cut to `limit`. |
| Merged | `resolve_label`, `resolve_label_by_language` | Local first. Only a local miss goes upstream, and the hosted answer is returned as it came. |
| Merged | `get_table_schema` | A table in the custom index is answered locally. For a standard table: the hosted schema, plus `localExtensions` (fields that custom table extensions add) and the custom objects that reference the table merged into `xrefs`. |
| Merged | `get_class_hierarchy` | A class in the custom index is answered locally. For a standard class: the hosted answer plus custom subclasses merged into `children`. |
| Merged | `find_field_access` | The hosted scan of standard X++ plus a local scan of custom X++, which is where code that reads or writes a standard field lives. One report; counts are added and every access row is tagged. |
| Merged | `find_references` | Union of the hosted list and the custom objects that reference the same object, deduplicated, local first, cut to `limit`. |
| Merged | `analyze_impact` | The hosted levels extended by the custom dependents; the local walk starts from the root and from every hosted node. Totals and `truncated` are recomputed, and an object is listed once, at the shallowest depth. |
| Merged | `find_usages` | Hosted call sites plus local usage rows. The local side has rows only if a compiler cross-reference snapshot was imported into the custom index, so it usually adds nothing. |
| Forwarded | everything else | See the list below. |

At the time of writing the forwarded tools of the hosted server are:

- Index: `get_index_stats`, `get_index_staleness`, `get_usage_snapshot_status`. They describe the
  hosted index; `local_index_status` is the custom index's counterpart.
- Security analysis: `find_security_path`, `analyze_sod_conflicts`, `diff_roles`,
  `convert_security_customizations`.
- Entities and generators: `check_entity_odata_readiness`, `create_data_entity`,
  `create_security_privilege`, `create_readonly_role_for_entities`, `create_odata_action`,
  `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`.
- Code quality: `get_bp_findings`.
- Traces, telemetry and batch analysis: `list_trace_sessions`, `find_n_plus_one`, `find_slow_sql`,
  `get_top_methods`, `search_trace`, `generate_kql_query`, `analyze_batch_class`.
- Release plans: `search_release_plans`, `check_feature_impact`.

A tool the hosted server adds later is forwarded as well, and so are the hosted resources (the
knowledge base) and prompts. The gateway offers no resource templates of its own. The write tools
are not registered in the gateway, and a hosted server refuses them.

## How rows are tagged

Merged lists say which side each row came from.

| Field | Meaning |
| --- | --- |
| `source: "local"` | The row comes from the custom index on this machine. |
| `source: "hosted"` | The row comes from the hosted index. |
| `source: "both"` | `list_packages` and `list_models` only: the name exists on both sides. |
| `shadowedHosted: true` | On a local row: the hosted index has a row with the same identity (type and name; label id and language; the reference tuple), which was dropped in favour of the local one. |

Local rows lose their numeric `id`: it is a row id of the local database and would collide with
hosted ids. Rows inside merged whole-object answers are tagged too: `xrefs` and `localExtensions`
of `get_table_schema`, `children` of `get_class_hierarchy`, the access rows of `find_field_access`
and the dependents of `analyze_impact`. A table or class answered by the custom index alone is
that tool's own answer and carries no tags.

Owner-routed and forwarded answers come from one side as that tool gives them, so they carry no
tags. Items the hosted server appends after its payload, such as the `{"knowledge": ...}` hint, are
kept in place. When one side could not answer, a trailing item names the reason:

```json
{ "gateway": { "warnings": ["hosted unavailable: The hosted MCP server at <host> did not respond within 15000 ms."] } }
```

## Failure modes

**The hosted server is unavailable** (unreachable, too slow, or it rejects the key):

- Merged tools return the local results with a `hosted unavailable: <reason>` warning. A single
  failure is remembered for the rest of that call, so a tool that would make several hosted calls
  does not wait for a timeout on each.
- Owner-routed tools answer locally when the custom index holds the object. Otherwise they return
  the local answer (usually "not found" with local suggestions) plus the warning.
- Forwarded tools return an error result: `hosted server unavailable: <reason>.`
- Local-only tools are unaffected.
- `tools/list`: a hosted tool list that was received once is served stale while a refresh fails. If
  none has been received since the gateway started, the list holds only the tools the custom index
  can answer, with descriptions starting `[hosted unavailable]`; when the hosted tools arrive, the
  gateway sends `tools/list_changed` (some clients need a manual refresh).
- Recovery is automatic. The hosted tool list is cached for 60 seconds and, after a failure, retried
  no more often than every 5 seconds. After a failed call the hosted server is left alone for 5
  seconds (calls in that time fail at once with "not connected"); the first call after that goes
  through, and a success makes the hosted side available again, with no restart. A hosted session
  that expired is replaced once per request; any other failure drops the connection, asks the hosted
  server to end its session, and the next call starts a new one. `local_index_status` keeps showing
  `hosted.reachable: false` until a hosted call succeeds.
- Failing to reach the hosted server at startup is a warning, not an error. Reasons shown to the
  agent name the hosted host but contain no URL, file path or credential.

**Version or schema skew:**

- The gateway compares its version with the hosted server's by major and minor. A difference is
  logged and shown as `hosted.versionNote` in `local_index_status`. `doctor` reports it too.
- For each merged tool, the gateway compares the hosted tool's argument names with its own, and the
  allowed values (enum members, minimum and maximum) of each. When they differ, the tool is skewed: the call is forwarded without merging and answered with a warning
  that says so. `local_index_status` lists these under `skewedTools`. Update the gateway (or ask
  the operator to update the hosted server) to restore merging.
- `D365_APP_VERSION` is separate: it lets the hosted server tell the agent when its index describes
  another application version than yours.

**The custom index fails to refresh:** the previous index stays in service and `local_index_status`
shows `lastError` (folder paths replaced by `<customDir>` and `<dbDir>`). If the file watcher
cannot start or fails, `watcher` shows `error` and the periodic re-check takes over.

## Refresh behavior

- At startup the custom folder is scanned before the gateway listens. A scan is incremental: files
  whose path and modification time are unchanged are skipped.
- A recursive file watcher marks the index dirty when an XML file, a label file (`*.label.txt`) or
  an entry without a file extension, such as a directory, changes. A refresh waits until changes
  have stopped for one second (and at most five seconds into a burst that never stops, such as a
  build).
- The refresh is lazy and shared. It runs when the next tool call that uses the custom index arrives
  (local-only, owner-routed or merged), and that call waits for it, so the answer reflects the edit.
  Forwarded tools never touch the index.
- Independently of the watcher, the next such call re-checks the folder when the last check is older
  than `D365_GATEWAY_REINDEX_TTL_MS`.
- Deleted files are removed from the index. After a branch switch or mass delete, if rows of
  missing files remain, the gateway rebuilds the custom index from scratch by itself.
- A file whose real path is outside the custom folder is not indexed: a symbolic link or junction
  that leads elsewhere on the machine (or nowhere) is skipped, so a repository checked out into the
  folder cannot get other files read into the index. Links that stay inside the folder are followed.

## Privacy

The gateway indexes your custom code locally and does not upload it. It does send tool arguments to
the hosted server for most tools, and those arguments can contain custom object names.

**What never leaves the machine**

- The contents of the custom index and the files behind it: X++ source, method bodies, element XML,
  field and index definitions, label texts, cross-references, file names and folder paths. The
  gateway sends upstream only the arguments the agent passed, exactly as received; it adds nothing
  it read from the custom index. What the agent puts into those arguments, typically names it saw in
  earlier local answers, is covered below.
- Source passed in `check_xpp_best_practices` (`source`), and the answers of `local_index_status` and
  `get_visual_studio_workspace`.
- Calls the custom index answers by itself, as the table below shows.

**What can leave the machine**

- Connection facts on every hosted session: the hosted API key (as `X-API-Key`, over HTTPS), the
  client name `d365-fno-mcp-gateway` with the gateway version, and the application version from
  `D365_APP_VERSION` or declared by your client.
- The arguments of tool calls, exactly as the agent wrote them. A custom object, field or label name
  appears upstream whenever it is an argument of a call that goes there:

| Call | Sent to the hosted server |
| --- | --- |
| Forwarded tools | Always, with every argument (including pasted content such as the `xml` of `convert_security_customizations` and the field lists of generators). |
| Owner-routed tools | Only when the named object is not in the custom index; then with every argument, including a generator's draft specification (extension, field and method names). |
| `get_table_schema`, `get_class_hierarchy` | Only when the table or class is not in the custom index. |
| `resolve_label`, `resolve_label_by_language` | Only when the label is not found locally. |
| `list_objects` | Unless `package` names a package the custom index holds. |
| `search_symbols`, `search_labels`, `search_labels_fts`, `find_references`, `find_usages`, `find_field_access`, `analyze_impact` | Always, even when the name is a custom object. |
| `list_packages`, `list_models` | Always, with no arguments. |
| `local_index_status`, `get_visual_studio_workspace`, `check_xpp_best_practices` with `source` | Never. |

- Resource reads (the `d365kb://` knowledge base) and prompt requests are relayed to the hosted
  server with their URI and arguments, without the prefix check below.

The hosted server and its operator can see these arguments. Treat a custom name as information you
share with them, and ask the operator what the hosted server logs.

**Mitigation: `D365_GATEWAY_PRIVATE_PREFIXES`**

Set it to the prefixes of your own objects, for example `Contoso,Fabrikam`. Each entry must be a
plain name prefix: letters, digits and underscores, not starting with a digit. An entry with
anything else (`Contoso*`, `@Contoso`, `Contoso.`) could never match a name, so the gateway refuses
to start and `doctor` fails instead of filtering nothing. Every string in a call's
arguments, at any depth, is split into identifiers; if one starts with a listed prefix
(case-insensitive), nothing is sent for that call. `Contoso` matches `ContosoCustTable`,
`CustTable.Contoso` and `@Contoso:Label` but not `NotContoso`. Argument names (keys) are not scanned.

- A forwarded tool returns an error: "Not sent to the hosted server: the arguments contain a name
  with a private prefix ...".
- An owner-routed or merged tool returns the local answer with a `hosted lookup skipped` warning.
  Hosted calls that a merge builds itself are checked too.

The prefix list is a name filter, not a classifier. A custom name without a listed prefix still
goes upstream, and the resource and prompt relays are not filtered. Without a naming convention
there is no protection, so keep the list in line with your customer and ISV prefixes.

## Security notes

- **Loopback only.** The gateway binds `127.0.0.1`; no setting changes that.
- **Host allow-list.** Only `Host: 127.0.0.1:<port>` and `Host: localhost:<port>` are answered (also
  without the port when it is 80). Any
  other host name gets `403` before rate limiting and authentication, `/health` and `/live`
  included. This stops a web page in your browser from reaching the gateway through DNS rebinding.
- **Bearer token.** Every request except `/health` and `/live` must carry the token as
  `Authorization: Bearer <token>` or `X-API-Key: <token>`. It is compared in constant time. The
  token is never logged or printed; logs record only the key name `gateway`.
- **Token file.** `gateway-token` is created with mode `0600` (owner read and write), and the mode
  is set again on every start. Windows ignores POSIX modes, so keep the folder in your user profile
  there. Keep the file, and the whole `.d365/` folder, out of source control and shared drives.
- **The custom index holds your code.** `custom_index.db` has the same sensitivity as your source.
- **Hosted key.** It is sent only as the `X-API-Key` header to `D365_HOSTED_MCP_URL`, over HTTPS
  (plain HTTP only for loopback hosts), and is removed from every error message. Prefer
  `D365_HOSTED_API_KEY_FILE`.
- **Read-only.** The gateway registers no write tools and never enables `D365_ENABLE_WRITE_TOOLS`.
- **Limits.** 1000 requests per minute per client IP, 25 concurrent sessions, and sessions idle for
  30 minutes are closed together with their hosted session.

## Known gaps

- **Generators check one index.** A generator whose target is a custom object runs locally and
  resolves EDTs and labels against the custom index, which holds no standard objects: a table
  extension field typed with a standard EDT is reported as not found. A generator whose target is a
  standard object is validated by the hosted index, which does not know your custom EDTs or labels.
  Forwarded generators validate against the hosted index only, so a custom parent class
  (`generate_xpp_class`) or table (`create_data_entity`) is reported as not found.
- **Forwarded tools do not see custom objects.** This covers the security analysis tools
  (`find_security_path`, `analyze_sod_conflicts`, `diff_roles`), `check_entity_odata_readiness`,
  `get_bp_findings`, `analyze_batch_class` and the other forwarded tools. `get_security_object`
  is owner-routed and works for custom roles, duties and privileges.
- **Role extensions are not merged.** For a standard role, duty or privilege, `get_security_object`
  returns the hosted answer; custom extensions of it in the custom index are not added.
- **Impact chains beyond `maxDepth`.** `analyze_impact` finds a custom dependent of a standard
  object at most `maxDepth` levels from the root; a chain standard, standard, custom that is longer
  can be under-reported (the result's `caveat` says so).
- **Paging in `list_objects` is per side.** `offset` and `limit` apply to the hosted list and, on
  their own, to the local list, because the gateway does not know how many hosted objects precede a
  custom one. A page can hold up to twice `limit` rows while both sides have rows, and the order is
  sorted within a page, not across pages. Stepping `offset` by `limit` still visits every row of
  both sides.
- **Cross-reference usages are hosted only** unless you imported a snapshot into the custom index,
  so `find_usages` rarely lists custom call sites. `find_references` (declared structural
  references) and `find_field_access` (a scan of the custom X++) work without a snapshot.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Startup prints `Gateway configuration validation failed` | Each listed variable is wrong or missing. Fix them and start again; `npm run doctor` repeats the checks. |
| `Port <n> on 127.0.0.1 is already in use` | Another process (often a second gateway) holds the port. Stop it, or set `D365_GATEWAY_PORT` and update the client's URL. |
| Connection refused right after start | The first start is still indexing the custom folder; the gateway listens only after that. |
| HTTP `503 Server is starting` | The gateway is making its first contact with the hosted server. Retry shortly. |
| HTTP `401 Unauthorized` | The token is missing or wrong. Compare the client's token with `gateway-token` (or `D365_GATEWAY_TOKEN`). If you deleted the file, the next start generated a new token. |
| HTTP `403 Forbidden: Host header not allowed` | The client used another host name or port than `127.0.0.1:<port>` or `localhost:<port>`, or a proxy rewrote `Host`. Use `http://127.0.0.1:<port>/mcp`. |
| Warning `hosted unavailable: ... rejected the API key (HTTP 401)` | The hosted key is wrong or revoked. Check `D365_HOSTED_API_KEY` or the key file. |
| Warning `hosted unavailable: ... is unreachable (<code>)` | The hosted URL, DNS, VPN or proxy. `npm run doctor` shows the `/health` result. |
| Warning `hosted unavailable: ... did not respond within <n> ms` | The hosted server is slow or starting. Raise `D365_GATEWAY_UPSTREAM_TIMEOUT_MS`. |
| Few tools, descriptions start with `[hosted unavailable]` | The gateway has not reached the hosted server since it started. Fix the connection; the full list follows, and the client may need to refresh its tools. |
| A custom object is missing from results | Check `local_index_status`: `objects` and `lastError`. The folder must be laid out as `<Package>/<Model>/Ax<Type>/*.xml`. A change appears at the next local call after the one-second quiet period; `watcher: "error"` means only the periodic re-check applies. |
| A tool is listed in `skewedTools` | The hosted server's version of that tool takes different arguments or allows other values. It is forwarded without merging until the gateway and the hosted server match. |
| `hosted lookup skipped` warning | An argument contains a name that starts with one of the `D365_GATEWAY_PRIVATE_PREFIXES`; nothing was sent upstream. |
| Rows have no `source` | The tool is owner-routed or forwarded; its answer comes from one side untagged. |
| Anything else | Run `npm run doctor`, call `local_index_status`, and start the gateway with `MCP_LOG_LEVEL=DEBUG`. |
