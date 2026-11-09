# User and administrator guide

This guide separates **developer workflows** from **server operations**. These
are responsibilities, not server-enforced user and administrator roles: an
authenticated HTTP key can call the same MCP tools and read index status.
Metadata write tools, when enabled, use server-wide configuration and an
explicit model allowlist; do not treat an ordinary API key as a read-only credential.

## For developers

### Connect

For a hosted server, ask its operator for the HTTPS `/mcp` URL and a personal
API key. All clients use the authenticated HTTP endpoint.
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
[local agents](local-agents.md#2-register-the-two-mcp-servers) and the README
[transport section](../README.md#transport) for Claude Code and VS Code, or
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
`get_index_stats` also reports the application version the index describes and, on a hosted
server, the bundle it serves; operators can read the same with `GET /status` (see
[Transport](../README.md#transport)).
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
| Local HTTP | `MCP_TRANSPORT=http`, `MCP_HOST=127.0.0.1`, `MCP_API_KEYS` | Bind locally unless you provide a trusted TLS reverse proxy and network controls. |
| Hosted | Azure worker promotes a validated index; API uses named HTTP keys | Read-only runtime; only the private worker may build or promote production indexes. |
| Visual Studio gateway | Extension loopback gateway plus hosted API | Hosted metadata and local workspace tools share one MCP connection; hosted credentials stay in Credential Manager. |

Run `doctor` for local setup.
See the [configuration reference](../README.md#configuration) and
[hosted deployment](hosted-deployment.md) for complete environment variables,
client setup, capacity planning, and Azure operations.

### Maintain the index

For a local source, run `index` against `PackagesLocalDirectory`; optionally
run `index-xref` against `DynamicsXrefDB`. Runtime startup does not index local
packages. `index-status` compares a local package tree with its local index.

For hosted use, schedule the private Azure acquisition worker. It downloads the
approved SDK, builds a sibling candidate, validates it and atomically promotes
it while retaining the previous active index. The public API neither downloads
manifests nor accepts direct uploads.
Keep raw XML in a hosted index if you need `get_element_xml` or generator
checks, because the host has no source files. Details and rollback guidance
are in [hosted deployment](hosted-deployment.md#operations).

### Control access and writes

- HTTP requires an API key. With a key registry (`MCP_KEY_REGISTRY`), give each
  person their own developer key with `keys new <name>` or the `/admin` page,
  using the admin key; developers cannot create keys. A new key works at once,
  and `keys revoke <name>` ends its sessions within seconds, with no restart.
  Fixed keys in `MCP_API_KEYS` (32+ characters) still work, but changing them
  needs a configuration change and a restart. Only names are logged, and an MCP
  session is bound to the key that opened it. See
  [Developer keys](hosted-deployment.md#developer-keys).
- Every valid HTTP key can use MCP tools and read index status. Rate limiting
  is by client IP, not by key. Protect the endpoint and keys accordingly;
  `TRUST_PROXY_HOPS` must reflect only trusted proxies.
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
| Results do not match my SDK | `get_index_stats` or `GET /status` for the indexed application version, compared with your local SDK; the server compares the version you declare in `X-D365-Client-Sdk-Version`. |
| Write tool missing or target rejected | `D365_ENABLE_WRITE_TOOLS`, model descriptor and `D365_WRITABLE_MODELS`; run `doctor`. |
| Hosted server will not start | Verify the active database exists and passes candidate validation; inspect worker and API health logs. |
| Hosted index stale or unavailable | Check the active pointer and bundle integrity with `artifact status --verify`, `GET /status` for what a replica activated, then server startup logs. |
| Too many sessions or requests | `MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_API_KEY`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`, and proxy settings. |

See the [Visual Studio connection model](visual-studio-extension.md#connection-model)
and the [README troubleshooting section](../README.md#troubleshooting) for
additional diagnostics.
