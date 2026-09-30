# User and administrator guide

This guide separates **developer workflows** from **server operations**. These
are responsibilities, not server-enforced user and administrator roles: an
authenticated HTTP key can call the same MCP tools and read `/admin/index`.
Index uploads require a key named in `D365_INDEX_UPLOAD_KEYS`. Metadata write
tools, when enabled, use server-wide configuration and an explicit model
allowlist; do not treat an ordinary API key as a read-only credential.

## For developers

### Connect

For a hosted server, ask its operator for the HTTPS `/mcp` URL and a personal
API key. A local stdio client launches the server itself and needs no HTTP key.
Visual Studio users can use the D365 F&O MCP extension's **Configure
Connection** command or add `.mcp.json` beside their solution:

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
    }
  }
}
```

In Copilot Chat, select **Agent** mode and enable the server's tools. See
[hosted deployment](hosted-deployment.md#connecting-clients) for Claude Code,
VS Code, and header-handling alternatives, or
[Visual Studio extension](visual-studio-extension.md) for setup and testing.
Visual Studio's MCP connection does not imply that offline Finance Operations
project writes are supported; check the
[workspace limitations](../README.md#visual-studio-20222026-and-unified-finance-operations-development).

### Use the tools

| Goal | Starting points |
| --- | --- |
| Find and inspect metadata | `search_symbols`, `list_objects`, `get_table_schema`, `get_method_signature`, `get_element_xml` |
| Follow relationships | `find_references`; `find_usages` when a compiler XRef snapshot exists |
| Inspect labels and access | `resolve_label`, `search_labels`, `get_security_object`, `find_security_path` |
| Generate X++ or XML previews | `create_coc_extension`, `create_table_extension`, `create_data_entity`, `create_security_privilege`, `generate_xpp_class` |
| Read development guidance | `d365kb://{slug}` resources, or the `d365_pattern_assistant` prompt |

`search_symbols` accepts a non-empty name or term, an optional AOT type filter,
and a result limit (default 20, maximum 100). Prefix full-text matching searches
names, object types, and packages, prioritizes exact name matches, and falls
back to substring name matches when full-text search finds nothing. Use
`find_references` for structural relationships and
`find_usages` for compiler-derived call sites; these are different data sets.

For a field question, start with `get_table_schema`, then inspect its
references or usages. For a Chain of Command extension, check
`get_method_signature` before `create_coc_extension`. For entity and security
work, use `check_entity_odata_readiness` and `find_security_path` to verify
the indexed design. Generators return previews; they do not write files.
The [MCP tool catalog](../README.md#mcp-tools) lists the remaining tools.

Check `get_index_stats` and `get_index_staleness` before relying on results.
`find_usages` needs an imported compiler cross-reference snapshot:
`get_usage_snapshot_status` distinguishes no snapshot from no matches.
`find_references` is a structural alternative, not a compiler call graph.
The index describes AOT metadata, not live F&O business data or user role
assignments. Review generated code and never put credentials in prompts.

If the operator enables write tools, `write_table_extension` prepares a
preview and `apply_table_extension_change` requires the change ID and an
explicit offline-project acknowledgement. Inspect the target model and
project before applying; the server does not run a compiler or read unsaved
Visual Studio state. See the [write tool reference](../README.md#mcp-tools).

## For server operators

### Pick a deployment pattern

| Pattern | Setup | Main constraint |
| --- | --- | --- |
| Local stdio | `MCP_TRANSPORT=stdio`, local index, client starts `serve` | No HTTP key required; use an absolute `D365_INDEX_DB_PATH` in clients with varying working directories. |
| Local HTTP | `MCP_TRANSPORT=http`, `MCP_HOST=127.0.0.1`, `MCP_API_KEYS` | Bind locally unless you provide a trusted TLS reverse proxy and network controls. |
| Hosted | `D365_INDEX_URL` points to a published manifest, with named HTTP keys | Read-only: `D365_INDEX_ON_START=0` and `D365_ENABLE_WRITE_TOOLS=0`. |
| Hybrid | `pull-index --url <manifest-url>` to a local DB; configure local writes separately | The local metadata target still needs a valid workspace, unlocked model, and allowlist. |

Run `doctor` for local setup or `doctor --hosted` for a hosted deployment.
See the [configuration reference](../README.md#configuration) and
[hosted deployment](hosted-deployment.md) for complete environment variables,
client setup, capacity planning, and Azure operations.

### Maintain the index

For a local source, run `index` against `PackagesLocalDirectory`; optionally
run `index-xref` against `DynamicsXrefDB`. `D365_INDEX_ON_START=1` enables
incremental background indexing on startup when there is no published index.
`index-status` compares a local package tree with its index and optionally
with a server's current index.

For hosted use, schedule `scripts/publish-index.ps1` on a machine with the
source packages: it builds the index, optionally imports XRef when
`D365_XREF_CONNECTION_STRING` is configured, publishes a versioned package,
uploads it, and restarts the App Service. Alternatively,
`upload-index` sends a local index in verified chunks to the running HTTP
server. Set `D365_INDEX_PUBLISH_URL` to persist uploads across restarts;
without it, an uploaded index is served locally until the server restarts.
Keep raw XML in a hosted index if you need `get_element_xml` or generator
checks, because the host has no source files. Details and rollback guidance
are in [hosted deployment](hosted-deployment.md#operations).

### Control access and writes

- HTTP requires an API key of at least 32 characters. Give each person or
  automation a separate named entry in `MCP_API_KEYS`; only names are logged,
  and an MCP session is bound to the key that opened it. Revocation or
  rotation requires changing the server configuration and restarting it.
- Every valid HTTP key can use MCP tools and `GET /admin/index`. Only keys
  named in `D365_INDEX_UPLOAD_KEYS` can upload or cancel an upload. Rate
  limiting is by client IP, not by key. Protect the endpoint and keys
  accordingly; `TRUST_PROXY_HOPS` must reflect only trusted proxies.
- `D365_ENABLE_WRITE_TOOLS=1` registers preview/apply tools for all clients,
  not for a special administrator identity. `D365_WRITABLE_MODELS` authorizes
  literal `Package/Model` targets; an empty list rejects writes. Configure
  `D365_CUSTOM_METADATA_DIR` and, for project-integrated operations,
  `D365_VISUAL_STUDIO_WORKSPACE_DIR`. Use `doctor` to inspect capability
  warnings, model identity, and write authorization. Hosted mode rejects
  write tools entirely.

### Troubleshoot

| Symptom | First check |
| --- | --- |
| Client tools missing or unauthorized | Client MCP configuration and `X-API-Key`; Visual Studio may require enabling tools in Agent mode. |
| Object or usage result missing | `get_index_stats`, `get_index_staleness`, `get_usage_snapshot_status`, then `index-status` or `index-xref`. |
| Write tool missing or target rejected | `D365_ENABLE_WRITE_TOOLS`, model descriptor and `D365_WRITABLE_MODELS`; run `doctor`. |
| Hosted server will not start | `doctor --hosted`, manifest reachability and published-index/write-tool configuration. |
| Upload denied | Named key in `D365_INDEX_UPLOAD_KEYS`; inspect `GET /admin/index` for the key's upload allowance. |
| Too many sessions or requests | `MAX_CONCURRENT_SESSIONS`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`, and proxy settings. |

See [Visual Studio troubleshooting](visual-studio-extension.md#troubleshooting)
and the [README troubleshooting section](../README.md#troubleshooting) for
additional diagnostics.
