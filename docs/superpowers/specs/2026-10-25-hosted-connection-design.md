# Hosted connection: errors a developer can act on, and keys that rotate without a flag day

Part 2b of "improve the hosted server experience". It builds on Part 2a, [two packages](2026-11-03-two-packages-design.md),
which must land first. Part 1 (`GET /status`, the `x-d365-index-version` header, richer
`get_index_stats`, the gateway `doctor` check `gateway-hosted-index`) is committed. Part 3 (operator tooling:
status command, promote and rollback, deploy scripts) gets its own spec.

## What was asked, and decided

The audience is developers connecting to a hosted server, and the operators who hand them keys. The user chose three
things for this part:

1. Errors that say what to do (401, 429, 503).
2. Key rotation without restarting the server.
3. A command that issues a key (`keys new`), in the operator package only: the developer package never contains it. Rotation mechanism: no preference, so the recommended one is used:
   a keys file that the server re-reads when it changes.

Nothing else is added: no per-key rate limit, no OAuth, no Key Vault client in the server, no `keys list` or
`keys remove` (a key is retired by deleting its line).

## How it works today

- A request with no key, or a wrong one, gets `401 {"error":"Unauthorized: invalid or missing API key"}`. The text does
  not say which, and does not say how to send a key. No code in the repository reads that text; one test asserts it and one test stand-in copies it.
- The per-IP rate limit answers `429` with the JSON-RPC message `Too many requests`. `Retry-After` is already sent by
  the rate-limit library. The session caps answer `503` ("Server busy: maximum concurrent sessions reached") and `429`
  ("Too many sessions: this API key holds its maximum concurrent sessions") with no `Retry-After` and no advice.
  While a hosted replica starts, `/mcp` answers `503` with `Retry-After: 10`.
- The gateway and `doctor` turn an upstream failure into a fixed sentence. 401 and 403 become "rejected the API key
  (HTTP 401)"; every other status becomes "answered with HTTP 429" or "HTTP 503", so a developer cannot tell "wait a
  moment" from "ask the operator".
- Keys are read once at startup from `MCP_API_KEYS` (`name=key` entries) and `MCP_API_KEY` (named `default`). A
  repeated name is rejected. On the hosted API they are an App Service setting backed by a Key Vault secret, so a
  rotation is a setting change and a recycle, and a recycle drops every open session (sessions live in memory).
  `docs/user-and-admin-guide.md` says "Revocation or rotation requires changing the server configuration and
  restarting it."

## Design

### 1. Errors

Status codes do not change. Bodies keep their shape (`{"error": "..."}` for 401, JSON-RPC errors elsewhere). No text
contains a key, a key name, a path or a limit another caller could learn from.

| Case | Status | New text |
| --- | --- | --- |
| No key presented | 401 | `Unauthorized: no API key was sent. Send it as the X-API-Key header or as Authorization: Bearer <key>.` |
| Key presented, not recognised | 401 | `Unauthorized: the API key was not recognized. It may have been rotated; ask whoever issued it for the current key.` |
| Per-IP rate limit | 429 | `Too many requests from this address. Retry in N seconds.` N is the time to the end of the window, at least 1. |
| Per-key session cap | 429 | `Too many sessions: this API key already holds its maximum number of sessions. Close one you no longer use, or wait: idle sessions end after M minutes.` |
| Global session cap | 503 | `Server busy: the maximum number of concurrent sessions is open. Retry shortly; idle sessions end after M minutes.` |
| Replica starting | 503 | `Server is starting: the index is not ready. Retry in 10 seconds.` (already `Retry-After: 10`) |

`Retry-After` is sent on every 429 and 503 from the transport: the rate limit already does; the session caps send
`Retry-After: 30`. M is the idle timeout in whole minutes (default 30). No `WWW-Authenticate` header is added: an MCP
client that sees one may start an OAuth discovery this server does not support, and the plain text is what a person
reads.

The gateway (`UpstreamSession`, which `doctor` also uses) maps upstream statuses to actions. The sentences are built
from the host and a fixed reason, never from the server's body:

| Status | Message |
| --- | --- |
| 401, 403 | `The hosted MCP server at <host> rejected the API key (HTTP 401). It may have been rotated: get the current key from whoever issued it, then update D365_HOSTED_API_KEY or run setup again.` |
| 429 | `The hosted MCP server at <host> is limiting requests from this machine (HTTP 429); retry shortly.` |
| 503 | `The hosted MCP server at <host> is starting or at capacity (HTTP 503); retry shortly.` |
| other | unchanged |

### 2. Key rotation

**One name, several keys.** `parseApiKeys` accepts the same name more than once with different keys, so a rotation is
`alice=<old>` then `alice=<old>` plus `alice=<new>`, then `alice=<new>`. A repeated key, a bad name, a short key and a
placeholder are still rejected. The per-key session cap, the session binding and the logs use the name, so two keys of
one person count once. `describeApiKeys` shows `alice (2 keys)`.

**A keys file.** A new optional setting `MCP_API_KEYS_FILE` names a file in the same format, one entry per line (commas
also separate). Blank lines and lines starting with `#` are ignored. It adds to `MCP_API_KEYS` and `MCP_API_KEY`, which
stay fixed. At startup the file must be readable and valid, and at least one key must exist across all sources;
otherwise startup fails with a message that names the setting and not the path.

**Reload.** A new module `src/server/apiKeyStore.ts` (it imports nothing from `src/config.ts`, `configLoader.ts` or
`server/start.ts`) owns the list: `createApiKeyStore({ fixed, file? })` with `keys()`, `loadedAt()`, `onChange(listener)`
and `stop()`. With a file, it checks the file every 5 seconds (an unref'd timer; polling, because `fs.watch` is not
reliable on network shares) and re-reads it only when its modification time, size or inode changed (a stat follows
symlinks, so a Kubernetes-style symlink swap is seen). A read is capped at 64 KiB. A change is applied only if the file
parses without errors, is not empty, and (with the fixed keys) leaves at least one key. Otherwise the previous list is
kept and one warning is logged naming the problems (never a key value or the path). The list is swapped as one
reference; a request reads it once, so it never sees half a change. A successful load logs the names and the number
of keys.

**Revocation is real.** A session records a digest of the key that opened it (SHA-256, in memory only, never logged). When a
reload removes a key, every session opened with it is closed, including its open event stream. A session whose key
is still present is untouched, even if another key of the same name was removed. Authentication still runs on every
request, so a retired key gets `401` at once.

**Transport.** `createHttpApp` and `startHttpServer` accept `apiKeys` as the fixed list (as now: the gateway passes its
one token) or as a store. `start.ts` builds the store from the configuration and stops it on shutdown.

**Status.** `GET /status` gains `server.keysLoadedAt`: when the key list was last loaded from the keys file (startup
counts), or `null` when no keys file is configured. It lets an operator see that a rotation reached a replica. It
names no key and gives no count. The gateway `doctor` ignores the field.

**`doctor`.** The `api-keys` check reads the file too, reports a problem with the setting's name, and shows names with
key counts.

### 3. `keys new`

```text
d365-fno-mcp-server keys new <name> [--file <path>]
```

Operator package only: `src/cli/keys.ts` is imported by `src/index.ts` alone, and the Part 2a boundary test lists it.

`<name>` must satisfy the key-name rule (1 to 64 of letters, digits, `.`, `_`, `@`, `-`). The command makes a key of
64 hexadecimal characters from `crypto.randomBytes(32)` (the generator `setup` already has moves into
`src/server/apiKeys.ts`).

- Without `--file`: prints the key once, the `name=key` line to add to `MCP_API_KEYS` (or a keys file), and the
  command the developer runs with the developer package: `d365-fno-mcp setup --mode hosted --hosted-url https://<api>/mcp`, which asks for
  the key. The key is never put on that command line.
- With `--file`: appends `# issued <date> for <name>` and the entry to the keys file (created with mode 0600 when
  missing), by writing a temporary file in the same folder and renaming it, so a running server never reads a half
  file. It refuses to touch a file that has parse errors. If the name already has keys there it says so: both work
  until the older line is deleted. The server picks the change up within about 5 seconds.
- An invalid name or an unusable `--file` is a usage error (exit code 1, as for `setup`) whose message names the problem, not the path.

## Components

- `src/server/apiKeys.ts`: repeated names allowed, `parseApiKeysFile(text)` (comment and blank lines), `generateApiKey()`,
  `describeApiKeys` with counts.
- `src/server/apiKeyStore.ts` (new, operator build only): the store and the reload. The `ApiKeySource` interface the
  transport accepts is declared in `src/server/apiKeys.ts`, so the developer build never reaches the store.
- `src/server/httpTransport.ts`: `apiKeys` as list or store; the 401, 429 and 503 texts and `Retry-After`; a key
  digest per session; closing sessions on removal.
- `src/server/serverStatus.ts`: `server.keysLoadedAt` (a provider function, defaulting to `null`).
- `src/configLoader.ts`, `src/server/start.ts`: `MCP_API_KEYS_FILE`, the store, shutdown.
- `src/gateway/upstream.ts`: the status-to-action messages.
- `src/cli/keys.ts` (new), `src/cli/args.ts` and `src/index.ts`: the `keys` command and its help text.
- `src/cli/doctor.ts`: the `api-keys` check.
- Docs: README (HTTP auth, Configuration table, a rotation recipe, Troubleshooting rows for 401, 429 and 503),
  `docs/hosted-deployment.md` (Operations: rotate client access, API configuration),
  `docs/user-and-admin-guide.md` (the sentence about restarting), `docs/hybrid-gateway.md`, `CHANGELOG.md`.

## Rules this keeps

- Validate settings and tool input with zod; no `any`; named exports.
- A secret appears in no log line, status document, error, doctor line or test output. Messages name the setting.
- `serverStatus.ts` and the gateway still do not import the server configuration.
- Write tools stay off by default; no example enables them.

## Testing

- Parse: repeated names with different keys pass; repeated keys, bad names, short keys and placeholders fail; comment
  and blank lines; `describeApiKeys` counts.
- Store (real files in a temporary folder, a manual `checkNow()` instead of waiting for the timer): initial load; a
  valid change is applied; an invalid, empty or oversized change is ignored with one warning and the old list stays;
  a change back to valid recovers; an unchanged file is not read again; symlink swap; file removed while running keeps
  the previous list; `stop()` ends the timer; no key value or path in any log call.
- Transport: each 401 text; 429 with `Retry-After` and the seconds; both session caps with `Retry-After: 30` and
  the idle minutes; starting 503; a rotation overlap (old and new both work, then only the new one); revocation closes
  that key's sessions and open stream and leaves other keys' sessions alone; a store that throws on read cannot
  take a request down; the fixed list still works (gateway shape).
- Gateway: each status maps to its message; the key never appears; `doctor` shows the new text for a rejected key.
- `keys new`: the output for a valid name; the key is 64 hex characters and not in the developer command; `--file`
  creates a 0600 file, appends with a comment, refuses a file with errors, notes an existing name; a bad name is exit 1;
  a running store picks the appended key up.
- Spawned `serve` with `MCP_API_KEYS_FILE`: the file's key works, a new line is accepted without restart, a deleted
  line gives 401 and ends its session, `/status` shows `keysLoadedAt`. Run outside the sandbox, loopback only.
- Docs: no real-looking key, and the README CLI block still equals the help text.
- Typecheck, lint with no warnings, build, and the full suite pass.

## Out of scope

Per-key rate limits (the limit stays per IP; a shared egress address shares a budget, which the docs say). Reading
Key Vault from the server (the store is the place to add it later). `keys list` and `keys remove`. Delivering the keys
file to an Azure host: the docs describe the file and a mounted share, but nothing here can verify it against Azure.
Visual Studio extension messages (sub-project 4).

## Not verifiable here

How modification times behave on a real Azure Files share, and a real App Service deployment. Windows file locking when
the operator edits the file while the server reads it (the reader only reads, and `keys new` renames into place).
