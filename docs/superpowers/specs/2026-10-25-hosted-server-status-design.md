# Hosted server: say what it is serving — design

Part 1 of 3 under "improve the hosted server experience". The others are the developer connection experience
(errors, key rotation, onboarding) and the operator experience (status command, promote and rollback, deploy
scripts); each gets its own spec. Both build on this part.

## Intent

Anyone who uses or runs a hosted server can find out, without reading logs or code, **what it is serving**: which
D365 application version the index describes, when it was built, which bundle is live, and whether the server is
ready. Developers get it where they work, operators and monitoring get it from one HTTP call, and nothing new
is learnable by someone without a key.

Success: after connecting, a developer can see which index they are talking to and whether it matches their local
SDK; an operator can answer "what is live right now" with one authenticated request; `/health` behaves exactly
as before.

## What exists today

- The model is told the indexed application version and build time at session start (the `instructions` of
  `initialize`, built by `buildSessionInstructions`), with drift warnings. A person rarely sees that text.
- `get_index_stats` reports object and label counts, `builtAt` and the server version. It does not report the
  application version, where that version came from, or which bundle is live.
- `/health` returns `{ status, version }` and is unauthenticated. App Service health checks and swap warm-up,
  the Docker `HEALTHCHECK` and the Bicep availability test use it, by status code.
- The bundle id, pointer revision and application version of a hosted server appear only in the startup log line
  `Activated validated artifact bundle`.
- `INDEX_VERSION_HEADER` (`x-d365-index-version`) is defined in `src/indexer/appVersion.ts` with the comment
  "Header the server echoes with the application version its index describes", and nothing sends it.

## Design

### `GET /status`

Authenticated like `/mcp` (a valid API key, in `X-API-Key` or `Authorization: Bearer`; otherwise the existing
401). It is registered after authentication and before the readiness gate, so it answers while the server is
starting. It is rate limited like any other authenticated route, answers `Cache-Control: no-store`, and takes
no input.

```json
{
  "status": "ok",
  "you": { "keyName": "alice" },
  "server": { "version": "0.1.0", "startedAt": "2026-10-25T08:00:00.000Z", "uptimeSeconds": 3600 },
  "index": {
    "applicationVersion": "10.0.2428.63",
    "applicationVersionSource": "packages-dir",
    "builtAt": "2026-10-24T22:10:00.000Z",
    "schemaVersion": 7,
    "objects": 312044,
    "labels": 88120
  },
  "artifact": {
    "source": "azure-blob",
    "bundleId": "sha256:…",
    "pointerRevision": 12,
    "createdAt": "2026-10-24T21:40:00.000Z",
    "applicationVersion": "10.0.2428.63"
  },
  "sessions": { "active": 3, "max": 100, "maxPerKey": 0 }
}
```

- `status` is `"ok"` when the server is ready and `"starting"` otherwise; while starting, `index` and `artifact`
  are `null`. A local (non-hosted) server has `artifact: null` and takes the index fields from its database.
- `you.keyName` is the name of the key that made the request, never the key and never another key's name.
- `index.applicationVersion` is the version the session instructions already state: the one recorded in the index
  database, else the host's configured one. `applicationVersionSource` says which: the recorded source
  (`packages-dir`, `configured`, …), `configured` for the fallback, or `null` when the version is unknown.
  An unknown version is reported as `null`, never guessed.
- On a hosted server `artifact.applicationVersion` is the version declared by the bundle manifest. It is reported
  next to the index's own, so a disagreement between the two is visible instead of hidden.
- `sessions` are counts only. `maxPerKey` is `0` when only the global cap applies.
- Nothing in the document names a path, an environment variable or a secret.
- The whole description of the index (version, build time, schema version, counts) is cached for 60 seconds, so polling
  `/status` never rescans a large database and one document never pairs a new build time with old counts. The header
  reads the same cache. `get_index_stats` and the session instructions read the index each time, so they can be a
  minute ahead of `/status` after the index changes.
- If building the document fails, the response is a 500 with `{ "error": "status unavailable" }` and a logged
  error; it never affects the other routes.

### One description, three surfaces

A single builder produces the description of the index and of the live artifact. Every surface uses it, so they
cannot disagree, apart from that cache window:

1. `GET /status` (above).
2. `get_index_stats` gains `applicationVersion`, `applicationVersionSource` and, on a hosted server, `artifact`
   (`source`, `bundleId`, `pointerRevision`, `createdAt`, `applicationVersion`). The existing fields are
   unchanged, so current readers keep working. Through the hybrid gateway the tool already goes to the hosted
   server, so a developer sees the hosted values.
3. The `x-d365-index-version` header is sent on authenticated responses, with the application version of the
   index. It is omitted when the version is unknown, and never sent on a 401, so an unauthenticated caller learns
   nothing from it.

### What stays as it is

`/health` and `/live` are unchanged byte for byte: status plus server version, unauthenticated. So are the Docker
`HEALTHCHECK`, the App Service health check and swap warm-up path, the availability test and every Bicep alert.

### Gateway `doctor`

When `D365_HOSTED_MCP_URL` is set, `doctor` adds one check, `gateway-hosted-index`, after the key is accepted. It
calls the hosted `/status` with the hosted key and prints the index application version and build time, the bundle
id and the server version, and compares the application version with `D365_APP_VERSION` when that is set (a
mismatch is a `warn`, not a failure). A hosted server without `/status` (404) is skipped without a result, so an
older server is not reported as broken. The key never appears in any result.

`/status` is asked for beside the configured MCP endpoint, not at the root of the host: `https://<host>/mcp` gives
`https://<host>/status` and `https://<host>/d365/mcp` gives `https://<host>/d365/status`. A hosted URL whose path
does not end in `/mcp` (a trailing slash is ignored) is skipped without a result, because the gateway cannot know where
the server's other routes are, and the key must go only where the user pointed the gateway, never to a root path that
another application behind the same proxy may own. (`/health` carries no credential and stays at the host root.)

### Components

- `src/server/serverStatus.ts` (new): the `ServerStatus` types, `describeIndex` (the shared description of the index
  and the artifact) and `createStatusProvider`, which owns the 60-second count cache and `startedAt`.
- `src/server/httpTransport.ts`: an optional `status` provider in the options; the `/status` route; the
  `x-d365-index-version` header middleware; the `sessions` numbers, which the transport supplies itself.
- `src/server/start.ts`: remembers the activated bundle (`source`, `bundleId`, `pointerRevision`, `createdAt`) after
  `activateArtifactIndex` and hands the provider its inputs; the application version comes from the same function
  that feeds the session instructions.
- `src/indexer/buildIndex.ts`: `IndexStatsSummary` and `getIndexStats` gain the application version fields.
- `src/tools/metadata.ts`: `get_index_stats` passes the artifact description through.
- `src/cli/doctor.ts`: the `gateway-hosted-index` check.
- Docs: `docs/hosted-deployment.md` (the "Diagnose mismatch" row of the Operations table and Client connection),
  `docs/user-and-admin-guide.md` (Troubleshoot), the README hosted section and tool list, and the CHANGELOG.

### Error handling and compatibility

- No new configuration, and no change for a client that never calls the new route or reads the new fields.
- An older gateway talking to a newer server is unaffected; a newer gateway talking to an older server skips the
  new check.
- The route never reveals more to an authenticated caller than `get_index_stats` and the session instructions
  already do, plus the bundle id and pointer revision, which are hashes and counters.

## Testing

vitest, in `tests/transport.test.ts` and new files beside it. Listening-socket tests need local port binding.

- `/status`: 401 without a key and with a wrong key; 200 with either header form; the document matches the shape;
  `status: "starting"` with `index` and `artifact` null before readiness while `/health` answers 503; `you.keyName`
  is the caller's key name and no other; no secret, path or other key name appears anywhere in the body (assert
  on the serialized text with a distinctive key and path in the configuration).
- `/health` and `/live`: bodies and status codes pinned exactly, ready and not ready.
- Header: present with the application version on authenticated responses, absent when the version is unknown,
  absent on 401.
- Counts are cached: a second call within 60 seconds does not query again (injectable clock and counter).
- `get_index_stats`: new fields present, old fields unchanged, `artifact` present only when hosted.
- `doctor`: against a stand-in hosted server, `gateway-hosted-index` passes and prints the facts; a mismatch with
  `D365_APP_VERSION` warns; a server answering 404 for `/status` produces no result and no failure; the hosted
  key is absent from every result.
- `npm run typecheck`, `npm run lint -- --max-warnings=0`, `npm run build` and the full suite pass.

## Out of scope

- Authentication and error wording, key rotation, rate limiting per key (part 2).
- A status command for operators, promote and rollback, the deploy scripts (part 3).
- New Bicep alerts or dashboards, and any change to what `/health` returns.
- The Visual Studio extension showing the new information.

## Checked while writing this spec

- `resolveIndexAppVersion` in `src/server/start.ts` reads the version recorded in the database
  (`d365_app_version`), then falls back to the configured one; `/status` and the session instructions use the same
  function, so they cannot disagree.
- Nothing in the repository parses the `get_index_stats` text (searched `src/`, `vs-extension/`, `docs/`, `agents/`);
  only documentation names the tool, so additive fields break no reader.
