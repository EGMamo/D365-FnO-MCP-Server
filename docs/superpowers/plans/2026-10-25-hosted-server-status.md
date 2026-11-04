# Hosted server status — implementation plan

> **For agentic workers:** this plan was approved to be executed without a review stop. Implement task by task,
> test first. Steps use checkbox syntax.

**Goal:** a hosted (or local) server says what it is serving: an authenticated `GET /status`, richer `get_index_stats`,
the `x-d365-index-version` response header, and a `gateway-hosted-index` line in the gateway `doctor`.

**Architecture:** the indexer owns the facts about an index (`countIndexRows`, `readIndexApplicationVersion`); one new
module, `src/server/serverStatus.ts`, turns them into the documents and owns the 60-second cache; the shared HTTP
transport gets one optional `status` provider and stays inert without it (the gateway passes none); `start.ts` is
glue only; the gateway `doctor` reads `/status` with its own tolerant parser.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import suffixes), Node >= 24, Express 5, vitest, zod. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-25-hosted-server-status-design.md`

## Global Constraints

- No new dependency; do not run `npm install`. Named exports. Relative imports end in `.js`. Validate external input with `zod`.
- `src/server/serverStatus.ts`, `src/gateway/**` and `src/utils/clientEntry.ts` never import `src/config.ts`, `src/configLoader.ts` or `src/server/start.ts`. `src/indexer/**` never imports from `src/server/**`. `httpTransport.ts` imports `serverStatus.ts` as `import type` only (the gateway loads the transport).
- `tsconfig`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Lint must stay at zero warnings (`--max-warnings=0`): no `any`, no property access named `tool` outside a registration call (`tests/toolAnnotations.test.ts` scans for it).
- `/health` and `/live` stay byte-identical (bodies, codes, `Retry-After: 10`), and are never touched by the new code.
- A status document, a header, a log line or a test failure message never contains a key, a path, an environment variable name or another caller's key name. Build every object field by field; never spread a bundle, a manifest, a config or `getUsageSnapshotStatus`.
- Write tools stay off in every example. No real keys in docs (placeholders only).
- No commits unless asked; the working tree already holds uncommitted work from the setup task (`README.md`, `CHANGELOG.md`, `llms-install.md`, `src/cli/doctor.ts`, `tests/cli.test.ts`, `tests/workspaceDiagnostics.test.ts`, `src/server/start.ts`, and others): edit with exact-match edits, never `git checkout`/`stash` or wholesale rewrites.
- Tests that listen on a port (transport, spawned servers, the gateway doctor stand-in) need local port binding: run them outside the sandbox. Always run vitest with `--exclude '**/.claude/worktrees/**'`.

## Decisions that refine the spec

1. **`/status` answers 200 with a document whenever the caller is authenticated**, including while starting (`status: "starting"`, `index` and `artifact` null). It is registered only when the transport is given a `status` provider, so the gateway still answers 404.
2. **One version rule everywhere:** `index.applicationVersion` is `parseAppVersion(recorded || configured)?.text ?? null`, and the session instructions already say exactly that. It is also the only value that can reach the `x-d365-index-version` header, so the header holds digits and dots only. `applicationVersionSource` is `null` whenever the version is `null`; the recorded source (`packages-dir`, …) when the version was recorded (and `null` if it was recorded without a source); `configured` when it fell back to the server's own `D365_APP_VERSION`.
3. **Names:** the new builder is `describeServedIndex` (the private `describeIndex` in `appVersion.ts` builds the instruction sentence). `index.schemaVersion` comes from the database metadata, a positive integer or `null`; the spec's example value 7 is illustrative, the real value is 3.
4. **Cache:** one entry holds the whole index description (counts, `builtAt`, version, source, schema version) for 60 seconds, so a document is never self-inconsistent, and the header reads from it. A thrown error is never cached; a clock that steps backwards does not freeze it (`elapsed >= 0`).
5. **Artifact:** `artifact` holds exactly `source`, `bundleId`, `pointerRevision`, `createdAt`, `applicationVersion`, copied from the manifest and pointer, and means "activated by this process at startup", not "the store's current active bundle". On a bundle that activated, `artifact.applicationVersion` equals the index's (activation refuses a mismatch); the builder still takes them as independent inputs.
6. **Sessions:** `active` is the transport's own `sessions.size` (open or opening, the number the caps compare), `max` and `maxPerKey` its resolved limits.
7. **Header:** set on every response that passed authentication and a ready check; never on a 401, 429 or host refusal, and not on parser errors (they fail before auth). A provider that throws, returns null or returns an unusable value omits the header and never fails a request.
8. **`doctor`:** the `gateway-hosted-index` check never fails: every outcome except a clean read is a `warn`, a 404 produces no row, redirects are not followed, the body is capped at 64 KiB, the request is bounded to `min(upstreamTimeoutMs, 5000)`, and server text is validated (rejected when too long or off-charset, never truncated). It runs only after the key check passed.

## Review Focus

1. A malformed or very long `D365_APP_VERSION` must not turn authenticated responses into 500s or break clients with an oversized header. (Tasks 2, 3)
2. `/status` and the header while the server is starting (database not open) must answer, not throw. (Tasks 2, 3)
3. No path leaks from the bundle object, and no key or other caller's name from the document. (Tasks 2, 4)
4. A hostile `/status` answer (huge, endless, slow, non-JSON, redirecting, forging output lines) must not hurt `doctor` or leak the hosted key. (Task 5)
5. `/health`, `/live` and the gateway's own listener are unchanged. (Task 3)

---

### Task 1: Index facts and `get_index_stats`

**Files:**
- Modify: `src/indexer/buildIndex.ts` (`IndexStatsSummary`, `getIndexStats`, new helpers beside them), `src/tools/metadata.ts` (`MetadataToolOptions`, the `get_index_stats` registration)
- Test: `tests/indexMeta.test.ts`, `tests/metadata.test.ts`

**Interfaces — Produces:**
```ts
// src/indexer/buildIndex.ts
export function countIndexRows(db: Database): { objects: number; labels: number };
export interface IndexApplicationVersion { version: string | null; source: string | null }
export function readIndexApplicationVersion(db: Database, configuredVersion?: string | null): IndexApplicationVersion;
export function readIndexSchemaVersion(db: Database): number | null;
export interface IndexStatsOptions { configuredApplicationVersion?: string | null }
export function getIndexStats(db: Database, options?: IndexStatsOptions): IndexStatsSummary; // + applicationVersion, applicationVersionSource after usageSnapshot
// src/tools/metadata.ts
export interface MetadataToolOptions { sourceFilesAvailable?: boolean; configuredApplicationVersion?: string | null; artifact?: ArtifactDescription | null } // ArtifactDescription: type-only import from '../server/serverStatus.js'
```

- [ ] **Step 1: tests (`tests/indexMeta.test.ts`).** `readIndexApplicationVersion` on `openDb(':memory:')`: no meta and no configured → `{version: null, source: null}`; recorded `10.0.2428.63` with source `packages-dir` → both; recorded without a source → `{version, source: null}`; recorded `10.0.02428.063` → normalized `10.0.2428.63`; recorded unparseable (`latest`) → `{null, null}` and the configured value is **not** used (matches `resolveIndexAppVersion` today? No: today a truthy unparseable recorded value is returned as is and the instructions then say unknown; the rule is `parseAppVersion(recorded || configured)`, so an unparseable recorded value gives `null`); no meta, configured `10.0.2428.63` → `{version, source: 'configured'}`; configured `10.0.39` → `{null, null}`; configured with surrounding spaces → trimmed; recorded wins over configured. `readIndexSchemaVersion`: missing → `null`; `'3'` → 3; `'0'`, `'-1'`, `'abc'` → `null`. `countIndexRows` equals `getIndexStats` totals. `getIndexStats` gains the two fields and keeps every old key and value (`toMatchObject` of the old object), `usageSnapshot` untouched. Run: fails.
- [ ] **Step 2: implement the helpers and the `getIndexStats` change** (`getIndexStats` calls `countIndexRows`; new fields appended after `usageSnapshot`; both new parameters optional so ~20 callers compile unchanged).
- [ ] **Step 3: tests (`tests/metadata.test.ts`, in the `get_index_stats` describe).** New fields present; old fields unchanged; `artifact` absent without the option and with `artifact: null`, present and exactly the five fields with a value; `configuredApplicationVersion` fills `applicationVersion` with source `configured`; the tool description stays `Index status` and the input shape `{}`. Run: fails.
- [ ] **Step 4: implement the tool change:** `const stats = getIndexStats(db, { configuredApplicationVersion: options.configuredApplicationVersion }); const body = options.artifact ? { ...stats, artifact: options.artifact } : stats;` (the handler stays the last argument; `READ_ONLY_TOOL` unchanged).
- [ ] **Step 5: verify** `npm run typecheck && npm run lint -- --max-warnings=0 && npx vitest run --exclude '**/.claude/worktrees/**' tests/indexMeta.test.ts tests/metadata.test.ts tests/toolAnnotations.test.ts tests/gatewayLocalTools.test.ts tests/indexer.test.ts`.

### Task 2: The status module

**Files:** Create `src/server/serverStatus.ts`, `tests/serverStatus.test.ts`.

**Interfaces — Consumes:** Task 1's `countIndexRows`, `readIndexApplicationVersion`, `readIndexSchemaVersion`; `getMeta`/`META_KEYS` from `../indexer/db.js`. **Produces:**
```ts
export interface ArtifactDescription { source: 'azure-blob' | 'local'; bundleId: string; pointerRevision: number; createdAt: string; applicationVersion: string }
export interface IndexDescription { applicationVersion: string | null; applicationVersionSource: string | null; builtAt: string | null; schemaVersion: number | null; objects: number; labels: number }
export interface SessionCounts { active: number; max: number; maxPerKey: number }
export interface ServerStatus { status: 'ok' | 'starting'; you: { keyName: string }; server: { version: string; startedAt: string; uptimeSeconds: number }; index: IndexDescription | null; artifact: ArtifactDescription | null; sessions: SessionCounts }
export interface StatusProvider { indexVersion(): string | null; describe(input: { ready: boolean; keyName: string; sessions: SessionCounts }): ServerStatus }
export function describeArtifact(source: ArtifactDescription['source'], pointerRevision: number, manifest: { bundleId: string; createdAt: string; d365: { applicationVersion: string } }): ArtifactDescription; // frozen, five fields only
export function describeServedIndex(db: Database, counts: { objects: number; labels: number }, configuredApplicationVersion?: string | null): IndexDescription;
export interface StatusProviderOptions { version: string; database: () => Database | null; configuredApplicationVersion?: string | null; artifact: () => ArtifactDescription | null; now?: () => number; uptimeSeconds?: () => number; cacheTtlMs?: number } // cacheTtlMs default 60_000
export function createStatusProvider(options: StatusProviderOptions): StatusProvider;
```

- [ ] **Step 1: tests (`tests/serverStatus.test.ts`, in-process, `openDb(':memory:')`).** `describeArtifact` copies exactly five fields from a real manifest/pointer (build one with the fixtures in `tests/artifactContract.test.ts`, or a literal), is frozen, and `JSON.stringify` of a full `ValidatedArtifactBundle`-derived description contains no directory path; `describeServedIndex` null handling (never indexed database → all nulls and zero counts); `createStatusProvider.describe`: `ready: false` → `status: 'starting'`, `index`/`artifact` null and **`database()` never called**; ready → full document with `you.keyName`, `startedAt` an ISO string, `uptimeSeconds` from the injected function, sessions passed through; the document serialized contains no `d365_` env name, no path, nothing but the specified keys (assert the exact key set); the cache: second call within the TTL does not run the count again (spy `countRows` via a real second row added between calls: counts stay, then change after the injected clock passes the TTL), a clock stepping backwards does not freeze it, a throwing database is not cached (next call recovers), `indexVersion()` returns the normalized version from the same cache, `null` while the database is null, and does not throw for a closed database (returns `null`). Run: fails.
- [ ] **Step 2: implement** per the interfaces. `describe` reads `database()` only when `ready`; `indexVersion` swallows nothing silently it should report, but never throws (returns `null` on error, logs at debug level through `logger`); `startedAt` is computed once at creation from `Date.now() - uptimeSeconds() * 1000`.
- [ ] **Step 3: verify** `npm run typecheck && npm run lint -- --max-warnings=0 && npx vitest run --exclude '**/.claude/worktrees/**' tests/serverStatus.test.ts tests/clientEntry.test.ts` (the second file holds the import-boundary scan; extend its `forbidden` check, or add one beside it, so `src/server/serverStatus.ts` is scanned for `config.js`, `configLoader.js` and `server/start.js`).

### Task 3: Transport: route and header

**Files:** Modify `src/server/httpTransport.ts` (import at line 8; `HttpTransportOptions` after `allowedHosts`; the readiness JSDoc; a block between the auth middleware and the readiness gate). Test `tests/transport.test.ts`.

**Interfaces — Consumes:** `StatusProvider`, `SessionCounts` (type-only import). **Produces:** `HttpTransportOptions.status?: StatusProvider`.

- [ ] **Step 1: tests (`tests/transport.test.ts`, after the `health endpoint` describe, using `makeApp(undefined, { status, readiness })`, `listen`, and a hand-written stub provider so the tests do not depend on Task 2).**
  - `/status`: 401 without a key and with a wrong key; 200 with `X-API-Key` and with `Authorization: Bearer ${SECOND_KEY}` and `you.keyName` equal to `second` in the second case; the body contains neither key value nor the other key's name; `Cache-Control: no-store`; HEAD gives 200 and an empty body; `sessions` equals `{active, max, maxPerKey}` of the transport (after a real initialize `active` is 1; `max` is the `maxConcurrentSessions` override; `maxPerKey` 0); a throwing provider gives 500 `{ "error": "status unavailable" }`, `logger.error` is called (spy), and `GET /nope` still answers 404; with `rateLimitMaxRequests: 3` the fourth call is 429 with the JSON-RPC body.
  - Starting: copy the readiness test shape (`ready` flag): `/health` 503 with `Retry-After: 10`, `/status` 200 with the stub's starting document, `/nope` 503, `/status` without a key 401; then ready.
  - Header: present (`x-d365-index-version`) on the 200 `/status`, on the initialize POST (read `res.text()` after checking `res.headers`), absent on a 401, absent on `/health` and `/live`, absent when the provider returns `null`, absent and no 500 when it throws, absent while not ready even if the provider would return a value, and absent (no 500) for values with CR/LF, non-Latin-1 characters or 20,000 characters.
  - Pinned: `/health` ready `{"status":"ok","version":"0.1.0"}`, not ready `{"status":"starting","version":"0.1.0"}` with `retry-after: 10`, `/live` `{"status":"alive","version":"0.1.0"}` in both states — read as text, with and without a `status` option.
  - No provider: authenticated `GET /status` is 404 `{ error: 'Not Found. MCP endpoint is at /mcp' }` and no header is sent.
  Run: fails.
- [ ] **Step 2: implement** the block exactly where Hazard notes say (between the end of the auth middleware and `// ── Readiness gate`), only `if (options.status)`: the header middleware (value `isReady() ? status.indexVersion() : null`, set only when it matches `/^[0-9]+(\.[0-9]+){3}$/`, all inside try/catch, then `next()`), then `app.get('/status', …)` with `try { res.set('Cache-Control', 'no-store').json(status.describe({ ready: isReady(), keyName: res.locals.apiKeyName as string, sessions: { active: sessions.size, max: maxConcurrentSessions, maxPerKey: maxSessionsPerApiKey } })); } catch (err) { logger.error('Status unavailable', { message: String(err) }); res.status(500).json({ error: 'status unavailable' }); }` (synchronous builder only). Amend the `readiness` JSDoc: authenticated requests other than `/status` are refused with 503.
- [ ] **Step 3: verify** `npm run typecheck && npm run lint -- --max-warnings=0` and, outside the sandbox, `npx vitest run --exclude '**/.claude/worktrees/**' tests/transport.test.ts tests/gatewayIntegration.test.ts tests/appVersion.test.ts`.

### Task 4: `start.ts` wiring and spawned tests

**Files:** Modify `src/server/start.ts` (`resolveIndexAppVersion`, a `servedArtifact` variable, `activateArtifactIndex`, the `registerMetadataTools` call, the `startHttpServer` options). Create `tests/serveStatus.test.ts`.

- [ ] **Step 1: tests (`tests/serveStatus.test.ts`, spawned `serve` from source with tsx, copying the `startServe`, `listeningPort`, `waitFor` and `stop` helpers from `tests/serveStartup.test.ts` — do not import from it, it is a test file).**
  - Local server with a fixture database (one object; meta `built_at`, `d365_app_version` `10.0.2428.63` with source `packages-dir`, `schema_version` `3`, `store_raw_xml` `1`) and `MCP_API_KEYS=alice=<40 chars>`: `GET /status` with the key → 200, `status: "ok"`, `you.keyName: "alice"`, `server.version` equal to `VERSION`, `index.applicationVersion` `10.0.2428.63`, source `packages-dir`, `schemaVersion: 3`, `objects: 1`, `artifact: null`, `sessions.max` 100; the response has `x-d365-index-version: 10.0.2428.63`; without a key 401; the serialized body contains neither the key nor the temp folder path; `/health` body unchanged.
  - Local server with **no** recorded version and `D365_APP_VERSION=10.0.39`: `index.applicationVersion` is `null` and `source` `null` (malformed configured value) and the header is absent, all other routes fine.
  - Hosted server on a local artifact store (build with `createArtifactBundle`, `promoteArtifactBundle`, `VERSION` and `INDEX_SCHEMA_VERSION` imported from `src`; `D365_ARTIFACT_STORE_PATH`, `D365_INDEX_DB_PATH` under the temp folder; wait for the log line `MCP server ready`): `artifact` has exactly the five fields with `source: "local"`, the manifest's `bundleId`, `createdAt` and `applicationVersion`, `pointerRevision` the promoted revision; `get_index_stats` called through an MCP client (`@modelcontextprotocol/sdk` client over HTTP, as `tests/mcpIntegration.test.ts` does) carries `artifact` and `applicationVersion`; the body names no path.
  Run: fails (needs a listening socket; run outside the sandbox).
- [ ] **Step 2: implement the glue.** `resolveIndexAppVersion` returns `readIndexApplicationVersion(requireDb(), config.appVersion).version`; `let servedArtifact: ArtifactDescription | null = null;` next to `db`; `activateArtifactIndex` returns after setting it via `describeArtifact('azure-blob' | 'local', pointerRevision, manifest)` **before** the caller runs `openIndex()`; `registerMetadataTools(server, db, { sourceFilesAvailable, configuredApplicationVersion: config.appVersion, artifact: servedArtifact })`; one provider created before `startHttpServer` with `createStatusProvider({ version: VERSION, database: () => db, configuredApplicationVersion: config.appVersion, artifact: () => servedArtifact })`, passed as `status:` after `readiness`. Pass explicit fields only, never `config`.
- [ ] **Step 3: verify** typecheck, lint, then outside the sandbox `npx vitest run --exclude '**/.claude/worktrees/**' tests/serveStatus.test.ts tests/serveStartup.test.ts` and, after `npm run build`, `tests/mcpIntegration.test.ts`.

### Task 5: Gateway `doctor`

**Files:** Modify `src/cli/doctor.ts` (`checkHostedIndex` below `checkHostedKey`; the call in `checkGateway`). Test `tests/workspaceDiagnostics.test.ts` (stand-in and a new describe), `tests/cli.test.ts` only if an assertion counts gateway results.

**Interfaces — Produces:** private `async function checkHostedIndex(settings: { hostedUrl: string; hostedApiKey: string; appVersion: string; upstreamTimeoutMs: number }): Promise<CheckResult[]>` and `function hostedStatusUrl(hostedUrl: string): URL | null` (the configured MCP URL with its last path segment `mcp` replaced by `status`, query and fragment dropped; null when the path does not end in `/mcp`, a trailing slash ignored; neither exported; reached through `checkGateway` so the final `redacted()` wraps it). It imports `classifySdkDrift` from `../indexer/appVersion.js` and nothing from `serverStatus.ts`.

- [ ] **Step 1: extend the stand-in** `startHostedStandIn(version = '0.1.0', options: { status?: ((req, res) => void) | null } = {})` in `tests/workspaceDiagnostics.test.ts`: wrap the `createHttpApp` listener so `GET /status` goes to the handler (recording request headers in `statusRequests`), everything else to the app; the default handler answers 401 unless `x-api-key` equals `HOSTED_KEY`, else 200 JSON with `status: "ok"`, `server.version: version`, `index.applicationVersion: '10.0.2428.63'`, `builtAt: '2026-10-24T22:10:00.000Z'`, `artifact.bundleId: 'sha256:' + 'ab'.repeat(32)`; `status: null` falls through to the app's real 404 (an older server). Update the ordered list in `passes against a healthy hosted server…` to end `…['gateway-version','pass'], ['gateway-hosted-index','pass']` and assert the message contains `10.0.2428.63`, the bundle id, and that exactly one `/status` request with the key was made. Run: fails.
- [ ] **Step 2: tests (new describe, each through `checkGateway(gatewayEnv({...}))`, `DOCTOR_TIMEOUT_MS`):** drift — `D365_APP_VERSION` `10.0.2428.63` pass "matches", `10.0.2400.10` warn (older release), `10.0.2428.60` warn (older hotfix), `10.0.2500.1` warn (newer), `10.0.39` pass "not a four-part version", hosted version `null` pass "records no four-part", unset → facts only; older server (`status: null`) → no row, the six old names unchanged, no `fail`; wrong key or unreachable server → no `/status` request and no row; warn outcomes via handler — 500, 429, 401, 302 to a second loopback server (assert it received nothing), 200 `text/html`, 200 JSON array, `index: "oops"`, a body over 64 KiB (endless writer that stops on close), a stall with `D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000'` (message says it did not answer within the budget), `status: "starting"` with `index: null`; secrets — a handler returning `bundleId` equal to `HOSTED_KEY` leaves neither the key nor its first 20 characters in `JSON.stringify(checks)` and shows `[redacted]`; fields with a newline or ESC produce `unknown`, never a forged line; read-only — `treeSnapshot(fixture.root)` unchanged; plus a `nextStep` table row: a `gateway-hosted-index` warn does not change `Next: run … gateway`. Run: fails.
- [ ] **Step 3: implement.** Request `fetch(hostedStatusUrl(hostedUrl), { headers: { 'X-API-Key': hostedApiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(budget), redirect: 'manual' })` with `budget = Math.min(upstreamTimeoutMs, 5_000)`; outcomes per Decision 8 (404 cancels the body and returns `[]`; 3xx, 401/403, 429/5xx, other statuses and network errors are warns with fixed wording and `describeNetworkError(error, budget)`, never echoing a body); a capped reader (64 KiB, counting decoded bytes, `reader.cancel()` over the cap); content type must be JSON; a tolerant zod schema (`z.string().max(n).regex(/^[A-Za-z0-9._:+-]+$/).nullish().catch(null)` per field, `builtAt` against an ISO pattern); message `Hosted index: application version <v|unknown>, built <t|unknown>; <bundle sha256:… | no artifact bundle>; server <v|unknown>` plus the drift sentence from `classifySdkDrift(settings.appVersion, index.applicationVersion)` only when `appVersion` is set. In `checkGateway` replace the single `results.push(...(await checkHostedKey(settings)))` with: keep the key results, and append `checkHostedIndex` only when the first key result is the `gateway-hosted-key` pass; leave the "Not checked" branch unchanged.
- [ ] **Step 4: verify** typecheck, lint, and outside the sandbox `npx vitest run --exclude '**/.claude/worktrees/**' tests/workspaceDiagnostics.test.ts tests/cli.test.ts`.

### Task 6: Docs and CHANGELOG

**Files:** `README.md` (Hosted startup, Hosted mode, Transport route table and example, SDK version warnings, Troubleshooting, the `get_index_stats` sentence), `docs/hosted-deployment.md` (Client connection, Operations table), `docs/user-and-admin-guide.md` (stats paragraph, Troubleshoot table), `docs/hybrid-gateway.md` (the doctor sentence, version skew bullet, `get_index_stats` mentions, a note that `/status` belongs to the hosted server and the gateway's counterpart is `local_index_status`), `docs/local-agents.md` (the connection check), `CHANGELOG.md`. Use exact-match edits; the README `CLI reference` block stays byte-identical to `HELP_TEXT`.

- [ ] **Step 1:** write each edit as listed in the docs research: the route table row and a `curl -H "X-API-Key: your-api-key" http://localhost:3000/status` example with the trimmed document, the response-header sentence in SDK version warnings, the "which index is this" troubleshooting row (an older server answers 404), the `/status` exception to "MCP requests get 503 while starting", and the advice to poll `/health` for liveness and `/status` rarely because it spends the per-IP rate-limit budget. Say `artifact` describes what this process activated at startup.
- [ ] **Step 2:** CHANGELOG, first `### Added` block (anchor on the last bullet "…in the gateway's refreshes."): `GET /status`, the header, the `get_index_stats` fields, the `doctor` check, "`/health` and `/live` are unchanged." Wrapped at about 100 columns with a two-space continuation.
- [ ] **Step 3:** run `npx vitest run --exclude '**/.claude/worktrees/**' tests/cli.test.ts -t "README"`; `grep -nE "X-API-Key: [A-Za-z0-9]{20,}" README.md docs/*.md` returns nothing; `ENABLE_WRITE_TOOLS=1` appears only where it already did.

### Task 7: Whole-change verification

- [ ] `npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && npm run knowledge-check`.
- [ ] The whole suite outside the sandbox: `npx vitest run --exclude '**/.claude/worktrees/**'` — compare with the last clean run (1,624 tests, 0 failed, 1 skipped), every new test file included.
- [ ] Adversarial review of the full diff against the spec and this plan; fix confirmed findings.
- [ ] State what was not verifiable: the Azure Blob activation path (it cannot be spawned; its mapping is unit-tested), a real hosted deployment, and Windows.

## Execution notes

Tasks 1–7 were implemented test-first as written. Two independent review rounds followed: two reviewers (security;
spec, tests and docs), then three fresh reviewers whose findings two skeptics each tried to refute. What they changed:

- **Doctor sent the key to the host root.** `checkHostedIndex` asked `<origin>/status`, so a hosted URL such as
  `https://host/d365/mcp` sent the key to `https://host/status`, which another application behind the same proxy may
  own. It now asks beside the configured MCP path (`hostedStatusUrl`) and asks nothing when the path does not end in
  `/mcp`. The spec and Task 5 say so; the tests mount the stand-in below a path and assert the root never sees a request.
- **Logged reasons were lost.** The logger writes its own `message` field after the meta, so the two new error and
  debug logs now use `error` (the key the other call sites use). The same mistake still exists at three older call
  sites in `httpTransport.ts` (session transport and server close, request failure after the response started); they
  are outside this change.
- **Hostile server text in older doctor rows.** The `/health` version and the MCP `serverInfo` version were only
  truncated to 64 characters; `plainVersion` now leaves out anything that is not a plain identifier.
- **`readIndexSchemaVersion`** accepts digits only (`Number()` read `0x10` as 16).
- **Docs:** the header is sent once the server is ready and not on `/health`, `/live`, `/status` while starting or
  refused requests; `/live` is liveness and `/health` readiness; the 60-second cache covers the whole description, so
  `/status` and the header can trail `get_index_stats` by up to a minute; `configured` is only the fallback source.
- **Tests that could not fail** were rewritten or added, each proved by a mutation that the suite now kills: start
  time computed once (only the clock moves), the registration of `get_index_stats` (description, empty input shape,
  annotations), the default clock and `process.uptime()`, the 5-second cap on `/status` (with a 30 s gateway timeout),
  each hostile field refused on its own, the JSON content-type rule, the schema-version and empty-version fallbacks,
  and the start.ts wiring of `D365_APP_VERSION` into `get_index_stats`. The doctor is also tested against the document
  the real status provider builds. The gateway tests pin that it answers 404 for `/status` and forwards the new
  `get_index_stats` fields. The spawned `serve` tests now bind loopback only.

Considered and left: a failing index read is not cached, so each authenticated request retries it (a closed database
throws at once, and the index is read-only after activation); `builtAt` and `applicationVersionSource` are served as the
index records them, and the bundle checksum vouches for the index.

Verified later against real Azure (2026-11-02, a throwaway storage account, deleted afterwards): the Azure Blob
activation path. A bundle published and promoted with the `artifact` commands was activated by `serve` with
`D365_ARTIFACT_SOURCE=azure-blob`; `/status` and `get_index_stats` reported `source: "azure-blob"`, the bundle id and
the pointer revision; the header carried the application version; the gateway `doctor` read it and warned on an older
`D365_APP_VERSION`. A second promotion changed nothing on the running server until it restarted (the documented
behaviour), a stale promotion was refused, and a rollback took effect on the next restart.

Not verified: an App Service deployment (managed identity, Key Vault references, private endpoints, the worker), and
Windows.
