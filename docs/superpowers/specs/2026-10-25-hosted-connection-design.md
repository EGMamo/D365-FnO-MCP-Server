# Hosted connection: keys managed on the server, and errors a developer can act on

Part 2b of "improve the hosted server experience". It builds on Part 2a, [two packages](2026-11-03-two-packages-design.md).
Part 2c, the [deploy walkthrough](2026-11-08-deploy-walkthrough-design.md), uses it. This replaces the earlier draft
(a keys file re-read on change, and keys in Key Vault).

## What was asked, and decided

- Developers must not be able to create keys; `keys` is in the operator package only.
- Keys are created **from the server**, with **no Microsoft sign-in, free of any**: an admin key protects key
  management. Both a page and commands ("Both").
- Errors that say what to do (401, 429, 503).

## Two kinds of key

- **Admin key**: manages developer keys, nothing else. `adm_` followed by 64 hexadecimal characters. It cannot open an
  MCP session. One per server; `keys reset-admin` replaces it.
- **Developer key**: opens MCP sessions, nothing else. 64 hexadecimal characters, one per name. Admin requests with
  one get `403`.

Both are made with `crypto.randomBytes(32)` and shown once. The server keeps only their SHA-256 digests (the keys are
256-bit random, so a plain digest is enough; no salt or slow hash is needed).

## The key registry

One JSON document, validated with zod:

```json
{ "version": 1,
  "admin": { "digest": "<sha256 hex>", "createdAt": "<ISO>" },
  "keys": [ { "name": "alice", "digest": "<sha256 hex>", "createdAt": "<ISO>" } ] }
```

Names follow the existing key-name rule (1 to 64 of letters, digits, `.`, `_`, `@`, `-`) and are unique.

**Where it lives** (`MCP_KEY_REGISTRY`):

- `azure-blob`: blob `key-registry.json` in `MCP_KEY_REGISTRY_CONTAINER` (default `d365-keys`, its own container) of
  `MCP_KEY_REGISTRY_ACCOUNT_URL`, through the server's managed identity (`DefaultAzureCredential`). Updates use the
  blob ETag (`If-Match`; `If-None-Match: *` for the first write), so two admins saving at once cannot overwrite each
  other: the loser retries on the fresh document once, then answers `409`.
- `file`: `MCP_KEY_REGISTRY_PATH`, for Docker or a local server. Written to a temporary file in the same folder and
  renamed, mode 0600; the version token is the file's mtime and size, checked before the rename.
- Unset: no registry, exactly today's behaviour (`MCP_API_KEYS` / `MCP_API_KEY` only, no `/admin`).

**Reading.** `src/server/keyRegistry.ts` (operator build only) loads the document at startup and re-reads it every
5 seconds (unref'd timer; only when the ETag or the mtime and size changed). An invalid or unreadable document keeps
the previous one and logs one warning naming the problem, never a digest or a key. At startup a configured registry
that cannot be read fails the start, naming the setting. A registry with no admin yet starts, and `/admin` says
`No admin key yet: run keys reset-admin.`

**Static keys.** `MCP_API_KEYS` and `MCP_API_KEY` keep working beside the registry. They are listed on the admin page as
`managed outside the server` and cannot be revoked there. A registry name that equals a static name is refused (`409`).

## Revocation is real

A session records the digest of the key that opened it (in memory only). When a reload no longer has that digest,
every session it opened is closed, including its open event stream. Authentication still runs on every request, so a
revoked key gets `401` at once on this replica, and within about 5 seconds on every other replica.

## The admin API and page

Mounted on the HTTP server only when a registry is configured. Auth: `X-Admin-Key: <admin key>`, compared as digests
with `crypto.timingSafeEqual`.

| Request | Answer |
| --- | --- |
| `GET /admin` | The page (below) |
| `GET /admin/api/keys` | `200 {"keys":[{"name","createdAt","source":"registry"|"settings"}]}` |
| `POST /admin/api/keys` `{"name"}` | `201 {"name","key"}`: the key is shown this once. `409` if the name exists; `400` for a bad name |
| `DELETE /admin/api/keys/:name` | `204`; `404` unknown; `409` for a static key |

- No admin key or a wrong one: `401 {"error":"Admin key required: send it as X-Admin-Key."}`. A developer key: `403
  {"error":"This is a developer key; key management needs the admin key."}`
- Rate limit: 20 admin requests per minute per address, `429` with `Retry-After`.
- HTTPS only: a request that is not HTTPS (as the configured `trust proxy` sees it) and does not come from a loopback
  address gets `403 {"error":"Key management is served over HTTPS only."}`.
- Audit: one info line per create or revoke, with the key name, the action and the client address; never a key or a
  digest. Failed admin authentications are logged as warnings with the address.
- Bodies are JSON up to 1 KiB. Responses carry `Cache-Control: no-store`.

**The page** is one static HTML document with inline CSS and script, served with
`Content-Security-Policy: default-src 'none'; script-src 'self' 'nonce-<n>'; style-src 'nonce-<n>'; connect-src 'self';
form-action 'none'; frame-ancestors 'none'` (`'self'` is not needed for scripts; the nonce is per response). It asks for
the admin key (kept in a variable, never in storage or the URL), then lists keys and has **New key** and **Revoke**.
A new key is shown once with a copy button and the developer command. No external resources.

## The `keys` command (operator package)

```text
d365-fno-mcp-server keys new <name>     --server <https://host>
d365-fno-mcp-server keys list           --server <https://host>
d365-fno-mcp-server keys revoke <name>  --server <https://host>
d365-fno-mcp-server keys reset-admin    (registry settings, see below)
```

- `new`, `list`, `revoke` call the admin API. The admin key comes from `D365_MCP_ADMIN_KEY`, or `--admin-key-file`,
  or a hidden prompt on a terminal; never a command-line value. `--server` accepts the host or the `/mcp` URL.
- `new` prints the key once and the developer command:
  `d365-fno-mcp setup --mode hosted --hosted-url https://<host>/mcp` (it asks for the key; the key is never on it).
- `reset-admin` writes the registry directly, not through the server: `--registry azure-blob --account-url <url>
  [--container d365-keys]` (with the caller's Azure CLI sign-in) or `--registry file --path <file>`. It creates
  the document when missing, replaces only the admin digest, keeps the developer keys, and prints the new admin key
  once. This is the one path that needs Azure access.
- Usage errors exit 1 with the problem named; an HTTP error prints the server's error text (it never contains a key).

## Errors

Status codes and body shapes do not change. No text contains a key, a key name, a path or a limit another caller
could learn from.

| Case | Status | Text |
| --- | --- | --- |
| No key | 401 | `Unauthorized: no API key was sent. Send it as the X-API-Key header or as Authorization: Bearer <key>.` |
| Unknown key | 401 | `Unauthorized: the API key was not recognized. It may have been revoked; ask your operator for a new key.` |
| Admin key on `/mcp` | 401 | same as unknown key |
| Per-IP rate limit | 429 | `Too many requests from this address. Retry in N seconds.` |
| Per-key session cap | 429 | `Too many sessions: this API key already holds its maximum number of sessions. Close one you no longer use, or wait: idle sessions end after M minutes.` |
| Global session cap | 503 | `Server busy: the maximum number of concurrent sessions is open. Retry shortly; idle sessions end after M minutes.` |

The session caps send `Retry-After: 30`. No `WWW-Authenticate` header. The gateway and `doctor` map upstream 401/403,
429 and 503 to: `... rejected the API key (HTTP 401). It may have been revoked: ask your operator for a new key, then
run setup again.`, `... is limiting requests from this machine (HTTP 429); retry shortly.`, `... is starting or at
capacity (HTTP 503); retry shortly.`

## Status

`GET /status` gains `server.keyRegistry`: `null` when none is configured, else `{ "kind": "azure-blob"|"file",
"loadedAt": "<ISO>"|null }`. No names, no counts.

## Azure template

`infra/modules/storage.bicep` grants the API identity Storage Blob Data Contributor on a new `d365-keys` container (not the operations container, so the API's write role reaches nothing else);
`apiApp.bicep` sets `MCP_KEY_REGISTRY=azure-blob`, `MCP_KEY_REGISTRY_ACCOUNT_URL`, `MCP_KEY_REGISTRY_CONTAINER`.
`MCP_API_KEYS` stays (the deploy smoke key `ci-smoke`).

## Components

`src/server/apiKeys.ts` (`generateApiKey`, `generateAdminKey`, `digestKey`, the `ApiKeySource` interface),
`src/server/keyRegistry.ts`, `src/server/keyRegistryFile.ts`, `src/server/keyRegistryBlob.ts`,
`src/server/adminRoutes.ts`, `src/server/adminPage.ts`, `src/server/httpTransport.ts`, `src/server/serverStatus.ts`,
`src/configLoader.ts`, `src/server/start.ts`, `src/gateway/upstream.ts`, `src/cli/keys.ts`, `src/cli/args.ts`,
`src/index.ts`, `src/cli/doctor.ts` (registry check), the two Bicep modules, README, `docs/hosted-deployment.md`,
`docs/user-and-admin-guide.md`, `CHANGELOG.md`.

## Testing

- Registry: parse and reject; file backend create, update, conflict, permissions 0600; blob backend against a fake
  container client (ETag create, update, conflict retry then 409); polling applies valid changes and keeps the old
  document on invalid ones; no digest or key in any log.
- Admin API: each status above; timing-safe comparison used; developer key 403; HTTPS rule (loopback allowed,
  forwarded `http` refused); rate limit; audit lines; static keys listed and not revocable; no-admin-yet message.
- Page: CSP header with a fresh nonce, no external URL, admin key not stored.
- Transport: the 401/429/503 texts and `Retry-After`; a created key works at once; a revoked key gets 401 and its
  sessions and stream close, other sessions untouched; an admin key cannot open `/mcp`.
- `keys`: each subcommand against an in-process server; admin key never accepted as an argument; `reset-admin` on a
  file registry keeps developer keys; usage errors exit 1.
- Spawned `serve` with a file registry: reset-admin, create a key with `keys new`, connect, revoke, see 401.
- Typecheck, lint, build, full suite.

## Out of scope

Per-key rate limits, key expiry, more than one admin key, an admin audit log stored in the registry.

## Not verifiable here

The blob backend against real Azure until the Part 2c end-to-end run; Windows.
