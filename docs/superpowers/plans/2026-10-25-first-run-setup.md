# First-run setup experience — implementation plan

> **For agentic workers:** this plan was approved to be executed without a review stop. Implement
> task by task, test first. Steps use checkbox syntax.

**Goal:** a developer goes from a fresh clone to an assistant making a successful tool call through
one guided `setup` (local or hosted+custom), a `serve` that prints how to connect, a `doctor` that
says what to do next, and an `index` that shows progress.

**Architecture:** five independent slices (shared client entry, index progress, shared checks and
doctor, gateway field validators, prompt helper) are built first; the `setup` rewrite then composes
them; docs come last so they describe shipped behaviour.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import suffixes), Node >= 24, vitest, zod,
`dotenv` (already a dependency). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-first-run-setup-design.md`

**Research notes:** every task was checked against the code first (exact lines, signatures, hazards, test
patterns). The notes were working files kept outside the repository, so what they established that matters
is in "Decisions that refine the spec", in each task's steps and in the Execution notes at the end. Where a
task says "grounding", that is what it means.

## Global Constraints

- Node >= 24; no new dependency; do not run `npm install` (`package-lock.json` is already modified).
- Validate env and inputs with `zod` or the existing validators; named exports only; relative imports end in `.js`.
- `src/gateway/**` and `src/utils/clientEntry.ts` must never import `src/config.ts`, `src/configLoader.ts` or `src/server/start.ts`.
- Write tools stay off: never emit `D365_ENABLE_WRITE_TOOLS` in a generated `.env`, help text or doc example.
- Secrets (API keys, hosted key, tokens) never appear in prompts, echoes, summaries, errors or test output.
- `HELP_TEXT` (`src/cli/args.ts`) is a template literal: no backticks, no `${`, and no `--server` substring (a test forbids it). README lines mirroring it stay byte-identical.
- Messages: sentence case, name the variable or flag, say how to fix, backticked commands, no emojis or exclamation marks; failures to `console.error`.
- `typecheck` has `noUnusedLocals`/`noUnusedParameters` as errors; lint must stay at zero warnings.
- Tests: flat `tests/<camelCase>.test.ts`, `os.tmpdir()` temp dirs removed in `afterEach`, `vi.restoreAllMocks()` and `vi.unstubAllEnvs()` in `afterEach`, explicit timeouts for tests that open SQLite or spawn a process, mode assertions guarded for `win32`. CI also runs on Windows.
- No commits unless the user asks. When one is requested, `git add` explicit paths only (the tree has unrelated changes) and end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Spawned-server and listening-socket tests need local port binding, which the sandbox blocks (`EPERM`); run those unsandboxed.

## Decisions that refine the spec

These come from the grounding hazards and apply to every task.

1. **Prompting uses one readline interface with a `line` queue**, not `rl.question()` (which loses piped lines, hangs at end of input, and drops an unterminated final line). Both follow-up questions ("run the checks?", "build the index?") are asked before `.env` is written, and the prompt is closed before either runs, so raw mode is released and `index` can be interrupted.
2. **Exit codes:** end of input before completion → 1 with nothing written; Ctrl-C → 130 with nothing written; a failed follow-up leaves `.env` and `setup` exits 0.
3. **Path answers are normalised once** (trim, strip one pair of surrounding quotes, expand a leading `~/`, `path.resolve` against `options.cwd`) before validating and writing. Interactive setup writes absolute paths for the packages folder, custom folder and key file; the index DB path is written as typed. Non-interactive setup writes values exactly as given (existing tests pin this).
4. **`.env` values are quoted when needed** so `dotenv` reads back exactly what was validated: quote any value containing `#`, with leading/trailing whitespace, or starting with a quote character; single quotes unless the value contains `'`, then backticks, else reject the answer; never double quotes (dotenv expands `\n` there).
5. **The in-process `doctor` follow-up gets an env built only from the answers**, never `process.env` (the old `.env` is already loaded into it).
6. **`doctor` gating covers two results:** `workspace-capabilities` and the unconfigured `visual-studio-workspace` warning (both would otherwise keep every healthy machine at two warnings).
7. **The shared packages-folder check becomes cheap** (fixed-depth probe, then a first-hit glob fallback) so the prompt does not walk a whole `PackagesLocalDirectory` three times.
8. **The hosted key charset rule moves to the source:** `resolveHostedApiKey` rejects what `UpstreamSession` rejects, so a key the prompt accepts can't fail only at `gateway` start.

## Review Focus

Failure modes the spec implies but a straight reading of the tasks would miss; each has a test in the named task.

1. Windows path with spaces, `#`, quotes or backslashes (for example `C:\Users\Jo Smith\Models #2`) written to `.env` must read back identical through `dotenv` and pass the gateway schema. (Task 6)
2. Several answers piped in one write, a final answer with no trailing newline, and empty stdin: all answers are consumed, the unterminated line is delivered, and empty stdin exits 1 with no `.env`. (Tasks 5, 6)
3. `setup --force` on a machine whose old `.env` is loaded into `process.env`: the follow-up `doctor` must judge the new answers, not stale `D365_HOSTED_MCP_URL`/`MCP_API_KEYS`. (Task 6)
4. A `Ctrl-C` or end of input at any prompt writes nothing and leaves the terminal usable (raw mode released). (Tasks 5, 6)
5. A progress callback or renderer that throws must not leave a half-built index with dropped FTS triggers. (Task 2)

---

### Task 1: Shared client entry and `serve` output

**Files:**
- Create: `src/utils/clientEntry.ts`, `tests/clientEntry.test.ts`, `tests/serveStartup.test.ts`
- Modify: `src/gateway/server.ts` (private `CLIENT_ENTRY_NAME`, `describeToken`, `printClientEntry`), `src/server/start.ts` (after the `await http.listening` try/catch, before `if (hosted)`)

**Interfaces — Produces:**
```ts
export const CLIENT_ENTRY_NAME = 'd365-fno';
export const SERVE_KEY_INPUT_ID = 'd365-mcp-api-key';
export interface ClientEntryOptions { name?: string; url: string; header?: 'Authorization' | 'X-API-Key'; inputId: string; inputDescription: string }
export interface ClientEntry { inputs: Array<{ id: string; type: 'promptString'; description: string; password: true }>; servers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }> }
export function buildClientEntry(options: ClientEntryOptions): ClientEntry;
export interface ClientEntryPrintout { heading: string; instruction: string; entry: ClientEntry; notes: readonly string[] }
export function printClientEntry(printout: ClientEntryPrintout, write?: (text: string) => void): void; // default console.log
export function serveEndpoint(options: { host: string; port: number; boundAddress?: string }): string;
export function printServeClientEntry(options: { host: string; port: number; boundAddress?: string; apiKeyNames: readonly string[] }, write?: (text: string) => void): void;
```

- [ ] **Step 1: characterization test (`tests/clientEntry.test.ts`) — `prints the gateway entry byte for byte`.** Feed the gateway's exact inputs (name `d365-fno`, input id `d365-gateway-token`, description `D365 gateway token`, `Authorization`, url `http://127.0.0.1:3101/mcp`) through `printClientEntry` with a capturing `write`; assert the writes equal `[`${heading}\n`, instruction, JSON.stringify(entry, null, 2), `\n${notes.join('\n')}`]` and the parsed JSON equals `{"inputs":[{"id":"d365-gateway-token","type":"promptString","description":"D365 gateway token","password":true}],"servers":{"d365-fno":{"type":"http","url":"http://127.0.0.1:3101/mcp","headers":{"Authorization":"Bearer ${input:d365-gateway-token}"}}}}` with that key order. Also `buildClientEntry` with `header: 'X-API-Key'` gives header value `${input:<id>}` with no `Bearer`. Run: fails (module missing).
- [ ] **Step 2: implement `src/utils/clientEntry.ts`** (zero imports; build the Bearer value by concatenation like the gateway). Run: Step 1 passes.
- [ ] **Step 3: switch the gateway.** In `src/gateway/server.ts` import `CLIENT_ENTRY_NAME`, `buildClientEntry`, `printClientEntry` (alias the import to avoid clashing with the private function name), delete the local `CLIENT_ENTRY_NAME`, keep `TOKEN_INPUT_ID` and `describeToken` there. Output must not change. Run `npx vitest run tests/clientEntry.test.ts tests/gatewayServer.test.ts` — pass.
- [ ] **Step 4: tests — `serveEndpoint` table** (and `new URL(result)` must not throw): `('', 3000, '::')`→`http://localhost:3000/mcp`; `('', 3000, '0.0.0.0')`→localhost; `('0:0:0:0:0:0:0:0', 3000, '::')`→localhost; `('127.0.0.1', 3000, '127.0.0.1')`→`http://127.0.0.1:3000/mcp`; `('::1', 3000, '::1')`→`http://[::1]:3000/mcp`; `('localhost', 3000, '::1')`→`http://localhost:3000/mcp`; `('myvm', 8080, '10.0.0.4')`→`http://myvm:8080/mcp`; wildcard detection uses `boundAddress` (`::`, `0.0.0.0`) and falls back to `host === ''`. Run: fails.
- [ ] **Step 5: tests — `printServeClientEntry`**: output contains `D365 MCP server listening on <url>`, the `${input:d365-mcp-api-key}` bearer header, the sentence that the entry replaces any existing `d365-fno` entry, the legacy-key line (`The key is the value of MCP_API_KEY; it is not printed.`) when the only name is `default`, a named-keys line (count and names) otherwise, the "replace localhost with this machine's name when connecting from another machine" note only for wildcard binds, and never a 40-character sample key passed anywhere near it (the function takes names only). Run: fails.
- [ ] **Step 6: implement `serveEndpoint` and `printServeClientEntry`** with the wording the printed instruction and the key note need (see `src/utils/clientEntry.ts` and its tests).
- [ ] **Step 7: wire `startServer`.** After the try/catch that ends at the `await http.listening` block and before `if (hosted) {`, when `!hosted` call `printServeClientEntry` with `http.server.address()` port/address (fallback `config.port`) and `config.apiKeys.map((e) => e.name)`. Print via `console.log` (stdout), never stderr or the logger.
- [ ] **Step 8: spawn test (`tests/serveStartup.test.ts`)** — `serve prints the MCP URL and a paste-ready entry once listening`: spawn `node --import <tsx> src/index.ts serve` with `MCP_PORT=0`, a 40-character `MCP_API_KEY`, temp `D365_INDEX_DB_PATH`, `D365_KNOWLEDGE_FILTER=0`, cwd = temp dir, `stdio: ['ignore','pipe','pipe']`; read the port from the stderr `MCP HTTP transport listening` line; assert stdout contains `http://localhost:<port>/mcp` and the header, the key appears in neither stream; SIGTERM. Second case `MCP_HOST=127.0.0.1` → `http://127.0.0.1:<port>/mcp`. Third case hosted (`D365_ARTIFACT_STORE_PATH` at an empty dir, as `tests/mcpIntegration.test.ts:276` does) → stdout stays empty. Needs a listening socket: run unsandboxed. 120 s timeouts.
- [ ] **Step 9: verify** `npm run typecheck && npm run lint && npx vitest run tests/clientEntry.test.ts tests/serveStartup.test.ts tests/gatewayServer.test.ts tests/mcpIntegration.test.ts` (unsandboxed for the last two) — pass.

### Task 2: Indexing progress

**Files:**
- Modify: `src/indexer/buildIndex.ts` (signature at `export async function buildIndex`, the scan loop), `src/cli/index-command.ts`
- Create: `tests/indexProgress.test.ts`
- Test: `tests/indexer.test.ts` (new `describe('buildIndex progress')`), `tests/cli.test.ts` (one assertion in the `index --force` test)

**Interfaces — Produces:**
```ts
export interface IndexProgress { files: number; done: boolean }
export interface BuildIndexOptions extends ScanOptions { onProgress?: (progress: IndexProgress) => void } // synchronous
// buildIndex 4th parameter type becomes BuildIndexOptions = {}; all current callers compile unchanged
export async function runIndexPass(packagesDir: string, dbPath: string, force: boolean, onProgress?: (p: IndexProgress) => void): Promise<IndexPassResult>;
export type ProgressOutput = { isTTY?: boolean; write(chunk: string): unknown };
export async function indexCommand(options: { force: boolean; packagesDir?: string; dbPath?: string }, env?: NodeJS.ProcessEnv, output?: ProgressOutput): Promise<number>; // output defaults to process.stdout
export function createProgressLine(output: ProgressOutput, enabled: boolean): { update(p: IndexProgress): void; finish(): void };
```

- [ ] **Step 1: tests in `tests/indexer.test.ts` (`buildIndex progress`)** using `stagePackages(root)` (8 files) and `openDb(':memory:')`: first call `{files: 0, done: false}`; last `{files: stats.total, done: true}`; exactly one `done: true`; `files` non-decreasing; `calls.length === stats.total + 2`. A callback that throws still resolves with `stats.added === 7`, `getMeta(db, META_KEYS.ftsPending) === '0'` and `logger.warn` called once. With 600 copies of a fixture and a callback, `logger.info` is not called with `'Indexing progress'`; without a callback it is (`{ files: 500 }`). Run: fails.
- [ ] **Step 2: implement in `buildIndex`:** `notify(done)` before the scan `try` (files 0), after `stats.total++`, and once after the `finally` that commits the last batch; wrap the call in try/catch (disable further calls and `logger.warn`); skip the structured `Indexing progress` log only when `onProgress` is set. Run: Step 1 passes; `tests/gatewayIndex.test.ts` untouched and still passes.
- [ ] **Step 3: tests (`tests/indexProgress.test.ts`)** in the style of `tests/prepareBundle.test.ts`: `indexCommand({ force: true, packagesDir, dbPath: ':memory:' }, {}, fake)` with `fake = { isTTY: true, write }`: chunks contain a `\r\x1b[2K` paint, the last chunk clears or finishes the line, no `console.log` line contains counter text, and a throwing `write` does not fail indexing; with `isTTY: false`, `undefined` or env `{ TERM: 'dumb' }` the chunks are empty. Counter wording is `Scanned <n> files` using a plain number (no `toLocaleString`). Run: fails.
- [ ] **Step 4: implement `createProgressLine` and wire `indexCommand`:** enabled only when `output.isTTY === true && env.TERM !== 'dumb'`; first call always paints, later paints at most every ~100 ms; `finish()` idempotent and called before `console.error` in the catch and in a `finally`; after the scan ends it writes `Scanned <n> files, finishing up...` until cleared. Rendering stays in `indexCommand` (never `runIndexPass`, which `prepare-bundle` shares).
- [ ] **Step 5:** extend the existing `index --force` test in `tests/cli.test.ts` with `expect(res.stdout).not.toMatch(/[\r\x1b]/)`; add a `prepare-bundle` assertion that no `\r` is written to stdout.
- [ ] **Step 6: verify** `npm run typecheck && npm run lint && npx vitest run tests/indexer.test.ts tests/indexProgress.test.ts tests/prepareBundle.test.ts tests/cli.test.ts tests/gatewayIndex.test.ts` — pass.

### Task 3: Shared checks and `doctor`

**Files:**
- Create: `src/cli/checks.ts`, `tests/checks.test.ts`
- Modify: `src/cli/doctor.ts`, `tests/workspaceDiagnostics.test.ts`, `tests/cli.test.ts`

**Interfaces — Produces:**
```ts
// src/cli/checks.ts
export interface CheckResult { name: string; status: 'pass' | 'warn' | 'fail'; message: string }
export async function checkPackagesDir(packagesDir: string | undefined): Promise<CheckResult[]>;
export async function checkCustomMetadataDir(dir: string): Promise<CheckResult>; // result name 'gateway-custom-dir'
export function firstProblem(results: readonly CheckResult[], options?: { rejectWarnings?: boolean }): string | null;
// src/cli/doctor.ts
export type { CheckResult } from './checks.js';
export function nextStep(results: readonly CheckResult[], env: NodeJS.ProcessEnv): string | null;
export async function doctorCommand(env?: NodeJS.ProcessEnv, options?: { showNext?: boolean }): Promise<number>; // showNext defaults to true
```

- [ ] **Step 1: pin current behaviour (`tests/checks.test.ts`, written against the *current* doctor semantics before moving anything):** undefined/blank/missing/file/quoted path → `packages-dir` fail; empty dir → `packages-dir` pass + `metadata-files` fail; `Package/Model/AxTable/X.xml` → all pass; a folder name containing glob characters (`[x]`, `{a,b}`) passes; custom dir: missing → fail, empty → warn, `Package/Model/AxTable` layout → pass with message matching `found Table <name> in <Package>/<Model>` (pinned by `workspaceDiagnostics.test.ts:254`). Run: fails (module missing).
- [ ] **Step 2: pure move.** Create `checks.ts` with `CheckResult`, `checkPackagesDir` and `checkCustomMetadataDir` copied from `doctor.ts` (both dynamic imports kept; `checks.ts` defines `CheckResult`, `doctor.ts` re-exports it); delete the `glob` import and the moved functions from `doctor.ts`; `checkDirWritable` stays. Run the full existing doctor tests (`tests/workspaceDiagnostics.test.ts`, `tests/cli.test.ts`) — unchanged and green.
- [ ] **Step 3: tests — cheap packages check:** a tree with `Package/Model/AxTable/X.xml` passes via the fixed-depth probe without calling `glob` (spy on the module's glob export or assert on a tree whose odd layout only the fallback finds: `deep/a/b/AxClass/Y.xml` passes via the fallback); a truncated sample XML gives `sample-parse` warn; the sample is deterministic across runs and never a `.label.txt`; the pass message is `D365 metadata XML found (e.g. <relative path>)` (replaces the count). Run: fails.
- [ ] **Step 4: implement the probe + first-hit fallback inside `checkPackagesDir`** (readdir `<root>/<Package>/<Model>/Ax{Table,Class,Enum,Form,Query,DataEntityView,Edt}/` first; if it misses, `globIterate` with the existing pattern and `windowsPathsNoEscape: true`, stop at the first hit). `packages-dir`/`metadata-files`/`sample-parse` names and fail/warn rules unchanged.
- [ ] **Step 5: tests + `firstProblem`:** first `fail` message; with `rejectWarnings` the first non-pass; `null` when all pass. Implement.
- [ ] **Step 6: tests — gating, on `checkVisualStudioIntegration` in the `workspace doctor checks` describe:** `{}` → no `workspace-capabilities` and no `visual-studio-workspace` result; `{ D365_ENABLE_WRITE_TOOLS: '1', D365_CUSTOM_METADATA_DIR: fixture.metadataDir }` → both present (the latter `warn`); `{ D365_VISUAL_STUDIO_WORKSPACE_DIR: fixture.workspaceDir }` → `workspace-capabilities` present; `{ D365_CUSTOM_METADATA_DIR: fixture.metadataDir }` alone → `custom-metadata-dir` pass and no `workspace-capabilities`. The existing test at line 105 stays unchanged and green. Implement: `const writeTools = env.D365_ENABLE_WRITE_TOOLS === '1'` and `workspaceConfigured = Boolean(env.D365_VISUAL_STUDIO_WORKSPACE_DIR)`; `workspace-capabilities` only when either; the unconfigured `visual-studio-workspace` warning only when `writeTools`.
- [ ] **Step 7: tests — `nextStep` table (`it.each`, handcrafted `CheckResult[]`, first match wins):** (0) no `D365_PACKAGES_DIR` and no `D365_HOSTED_MCP_URL` in `env` → ``Next: run `d365-fno-mcp-server setup`.`` ; (1) any fail → ``Next: fix the failed checks above (<de-duplicated names>), then run `d365-fno-mcp-server doctor` again.`` ; (2) `gateway-hosted-health` warn → hosted still starting, run `doctor` again; (3) `db-objects` warn → ``Next: run `d365-fno-mcp-server index`, then `d365-fno-mcp-server serve`.`` (append ` The gateway needs no index and can start now.` when `gateway-config` exists); (4) `packages-dir` and `gateway-config` both → serve or gateway; (5) `packages-dir` → ``Next: run `d365-fno-mcp-server serve`.``; (6) `gateway-config` → ``Next: run `d365-fno-mcp-server gateway`.``; (7) otherwise `null`. Other warnings never block. Implement `nextStep`; `doctorCommand` prints it after the summary line unless `showNext === false`.
- [ ] **Step 8: CLI tests:** extend `tests/cli.test.ts:76` (fresh DB) to expect ``Next: run `d365-fno-mcp-server index` ``; after the `index --force` test add a healthy run: exit 0, `0 failed, 0 warning(s)` and ``Next: run `d365-fno-mcp-server serve` ``. The footer `<n> checks, <n> failed, <n> warning(s).` and `[PASS] api-keys: 2 API key(s) configured: alice, bob` are unchanged.
- [ ] **Step 9: verify** `npm run typecheck && npm run lint && npx vitest run tests/checks.test.ts tests/workspaceDiagnostics.test.ts tests/cli.test.ts` (the `gateway doctor checks` describe needs a socket: unsandboxed).

### Task 4: Gateway field validators

**Files:**
- Modify: `src/gateway/config.ts` (after `resolveCustomMetadataDir`; `resolveHostedApiKey` charset rule), `tests/gatewayConfig.test.ts`

**Interfaces — Produces:**
```ts
export type FieldCheck<T> = { ok: true; value: T } | { ok: false; variable: string; message: string };
export function validateHostedUrl(raw: string): FieldCheck<string>;                                   // value = normalised URL (adds /mcp)
export function validateHostedApiKey(source: { key?: string; keyFile?: string }): FieldCheck<string>; // value = the SECRET key; callers discard it in key-file mode
export function validateCustomMetadataDir(raw: string): FieldCheck<string>;                          // value = canonical directory
```
Built through a private `checkField` that runs `gatewayEnvSchema.parse(input)` and the existing private validator with a collecting `issue` function (same trim and defaults as the schema; no private signature changes; no new imports).

- [ ] **Step 1: parity tests in a new `describe('field checks')` at the end of `tests/gatewayConfig.test.ts`:** for each input, `check.message` equals the problem `loadGatewayConfig` reports for that variable (minus `VARIABLE: `) and `check.value` equals `config.hostedUrl`/`hostedApiKey`/`customMetadataDir` when valid. Rows — URL: `''`, `'   '`, `' https://H.example.com '`, remote `http://`, `ftp://`, `nonsense`, credentials in URL, `/`, `http://localhost:3000/`; key: inline, blank, none, both, file ok, missing file, empty file, two-line file, directory, tab; dir: ok, padded, missing, a file, blank. Never-echo tests: the key pasted as `keyFile` and a two-line key file must not appear in `message` or `JSON.stringify(result)`. Run: fails.
- [ ] **Step 2: upstream parity test:** `validateHostedApiKey` accepts a key iff `new UpstreamSession({ url, apiKey, timeoutMs: 1000, gatewayVersion: '1.0.0' })` does not throw, for `ok-0123456789`, `abc def`, `clé`, `x\ty`. Today `abc def` and `clé` pass the config check and fail upstream; run: fails.
- [ ] **Step 3: implement** `FieldCheck`, `checkField`, the three validators, and in `resolveHostedApiKey` replace the control-character test with `/^[\x21-\x7e]+$/` and the message `the key must be printable ASCII without spaces or line breaks`. The existing multi-line key test and `tests/gatewaySessionRelay.test.ts:230` stay green. Add no length rule for the hosted key.
- [ ] **Step 4: verify** `npm run typecheck && npm run lint && npx vitest run tests/gatewayConfig.test.ts tests/gatewayUpstream.test.ts` (the upstream file needs sockets: unsandboxed).

### Task 5: Prompt helper

**Files:**
- Create: `src/cli/prompt.ts`, `tests/prompt.test.ts`

**Interfaces — Produces:**
```ts
export interface PromptStreams { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; terminal?: boolean }
export interface AskOptions { validate?: (answer: string) => string | undefined | Promise<string | undefined>; secret?: boolean; default?: string }
export interface Prompt { ask(question: string, options?: AskOptions): Promise<string>; close(): void }
export class PromptEndedError extends Error { constructor(readonly reason: 'eof' | 'interrupt') }
export function createPrompt(streams?: PromptStreams): Prompt;
```
`validate` returns the re-ask reason or `undefined` to accept; the answer is trimmed and a blank answer takes `default` before `validate` runs; a secret's default is never printed and a re-ask message never contains the answer. The prompt is a port of a reference implementation checked against 18 behaviours, with `validate` made to accept a promise.

- [ ] **Step 1: tests (`tests/prompt.test.ts`)** each racing the ask against a 300 ms timeout so a hang fails instead of stalling: (1) re-asks until `validate` accepts, answers fed in one write of three lines; (2) blank takes the default and prints `[default]`; (3) piped lines survive EOF and a later ask rejects `PromptEndedError` reason `eof`; (4) EOF via `end()`, `destroy()` and `destroy(new Error('boom'))` each reject within the race; (5) secret never echoed with `terminal: true` and a fake TTY, plus a control with `secret: false` that does echo; (6) Ctrl-C (`\x03`) rejects reason `interrupt` and `setRawMode` calls equal `[true, false]`; (7) `ask` after `close()` rejects; (8) a final line without a trailing newline is delivered; (9) async `validate` works; (10) no listener leak on the injected input after `close()`. Run: fails.
- [ ] **Step 2: implement `createPrompt`** with these Node calls (one `createInterface`, `terminal = streams.terminal ?? input.isTTY === true`, a muting `Writable` wrapper with a `columns` getter, a buffered `line` queue and waiter list, reject all waiters on `close`/`SIGINT`/`error`/input `close`, write the prompt with `output.write` once closed, write `\n` after secrets and in non-terminal mode). Run: Step 1 passes.
- [ ] **Step 3: verify** `npm run typecheck && npm run lint && npx vitest run tests/prompt.test.ts`.

### Task 6: `setup` flow, flags and help

Depends on Tasks 2–5.

**Files:**
- Create: `src/cli/envFile.ts`, `tests/envFile.test.ts`, `tests/setupInteractive.test.ts`
- Modify: `src/cli/setup.ts`, `src/index.ts` (the `setup` case), `src/cli/args.ts` (`HELP_TEXT` setup block), `README.md` (CLI block mirror), `tests/cli.test.ts`

**Interfaces — Consumes:** `createPrompt`/`PromptEndedError` (Task 5); `validateHostedUrl`/`validateHostedApiKey`/`validateCustomMetadataDir`/`FieldCheck` (Task 4); `checkPackagesDir`/`checkCustomMetadataDir`/`firstProblem` (Task 3); `doctorCommand(env, { showNext: false })` (Task 3); `indexCommand(options, env)` (Task 2); `parseApiKeys(undefined, key).errors[0]` for the local key.

**Interfaces — Produces:**
```ts
// src/cli/envFile.ts
export function quoteEnvValue(value: string): string | null;           // null: cannot be represented in a .env file
export function renderEnvFile(header: string, entries: ReadonlyArray<readonly [string, string]>): string; // throws if an entry cannot round-trip through dotenv.parse
// src/cli/setup.ts
export interface SetupOptions {
  nonInteractive: boolean; mode?: 'local' | 'hosted';
  packagesDir?: string; apiKey?: string; dbPath?: string; transport?: string; host?: string;
  hostedUrl?: string; hostedApiKey?: string; hostedApiKeyFile?: string; customDir?: string;
  cwd?: string; force?: boolean;
  input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; terminal?: boolean;              // prompt seams
  runDoctor?: (env: NodeJS.ProcessEnv) => Promise<number>;                                        // defaults to doctorCommand(env, { showNext: false })
  runIndex?: (options: { packagesDir: string; dbPath: string }, env: NodeJS.ProcessEnv) => Promise<number>; // defaults to indexCommand({ force: false, ... }, env)
}
export function normalizePathAnswer(answer: string, cwd: string): string; // trim, strip one quote pair, expand ~/, resolve; '' stays ''
export async function setupCommand(options: SetupOptions): Promise<number>;
```
`.env` keys: local → `MCP_TRANSPORT`, `MCP_PORT=3000`, `MCP_HOST` (only when chosen), `MCP_API_KEY`, `D365_PACKAGES_DIR`, `D365_INDEX_DB_PATH`; hosted → `D365_HOSTED_MCP_URL` (the validator's normalised value), exactly one of `D365_HOSTED_API_KEY` / `D365_HOSTED_API_KEY_FILE`, `D365_CUSTOM_METADATA_DIR` (the typed absolute path, not the realpath). Never `D365_PROJECT_DIR`.

- [ ] **Step 1: tests (`tests/envFile.test.ts`)** — `quoteEnvValue`/`renderEnvFile` round-trip through `dotenv.parse` for: plain, `#`, ` #`, leading/trailing space, values starting with `"`, `'` or a backtick, a value containing `'` (backticks), one containing both `'` and a backtick (null → `renderEnvFile` throws), `C:\Users\Jo Smith\Models #2` and `K:\AosService\PackagesLocalDirectory` (unquoted-safe stays unquoted), and `\new` (never double-quoted). Each parsed-back value equals the input. Run: fails. Implement.
- [ ] **Step 2: CLI wiring tests (`tests/cli.test.ts`)** — keep the existing two setup tests unchanged; add: `setup --non-interactive --mode hosted` with `--hosted-url`, `--hosted-api-key-file`, `--custom-dir` writes the three keys (mode 0600, win32-guarded) and `loadGatewayConfig`-style parse of the written file (via `dotenv.parse` + `gatewayConfigSchema.safeParse`) succeeds; hosted without a required flag exits 1 naming the flag and writes nothing; `--host 127.0.0.1` writes `MCP_HOST=127.0.0.1`; without `--host` no `MCP_HOST` (compat); a hosted `--hosted-api-key` and `--hosted-api-key-file` together exits 1; `HELP_TEXT` mentions `--mode`, `--host`, `--hosted-url`, `--hosted-api-key`, `--hosted-api-key-file` and `--custom-dir`; `readFileSync('README.md')` with CRLF normalised contains `HELP_TEXT.trimEnd()`. Run: fails.
- [ ] **Step 3: implement non-interactive paths and flag wiring.** Add the flags to `SetupOptions`, thread them in `src/index.ts` with `flagString`, update the `HELP_TEXT` setup block and the README mirror identically (lead with `--hosted-api-key-file`, note that `--hosted-api-key` is visible in the process list). Non-interactive hosted validation uses Task 4's validators with messages relabelled to the flags the user typed; secrets never echoed. Existing local non-interactive output (including ``Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server index`.``) is unchanged; hosted prints ``Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server gateway`.``.
- [ ] **Step 4: interactive tests (`tests/setupInteractive.test.ts`)** — in-process `setupCommand` with `PassThrough` input/output, `cwd` a temp dir, console spies, injected `runDoctor`/`runIndex` spies: (a) local happy path (mode `1`, valid fixture packages dir, blank key → generated, default DB path, `Y` to loopback, `Y`/`Y` follow-ups): `.env` has `MCP_HOST=127.0.0.1` and a 64-hex `MCP_API_KEY`, mode 0600, `runDoctor` called once with an env built from the answers only (assert it lacks a sentinel `process.env.D365_HOSTED_MCP_URL` set before the call — Review Focus 3), then `runIndex`, and the closing line names `serve`; (b) bad packages path then good (re-asks, message names the problem); (c) short typed key re-asks without echoing it; (d) all answers in one write (line-loss regression); (e) empty input → returns 1, `.env` absent, message `Input ended before setup finished; nothing was written.`; (f) Ctrl-C with a fake TTY → returns 130, `.env` absent; (g) hosted happy path with key file: `.env` has `D365_HOSTED_API_KEY_FILE=<absolute>` and no `D365_HOSTED_API_KEY`, `runIndex` never called, closing line names `gateway`; (h) hosted with typed key: the key is in `.env` but absent from `output` and every console spy; (i) a failing `runDoctor` (returns 1) leaves `.env` and `setup` returns 0 with the retry command printed; (j) Windows-style answer `C:\Users\Jo Smith\Models #2` for the custom folder (use a real temp dir whose name contains a space and `#`) round-trips; (k) quoted `"path"` and `~/` answers are normalised; (l) existing `.env` without `--force` still refuses. Run: fails.
- [ ] **Step 5: implement the interactive flow in `setup.ts`:** ask mode (`1`/`2`); local: packages path (validate: `normalizePathAnswer`, reject blank, `firstProblem(await checkPackagesDir(...))` fail-only so a `sample-parse` warning is shown and accepted), API key (secret, blank generates, validate with `parseApiKeys(undefined, answer).errors[0]` and messages that never quote the answer), index DB path (default `options.dbPath ?? './d365_index.db'`; reject when the nearest existing ancestor is not a directory), loopback `Y/n`; hosted: URL (`validateHostedUrl`), key source `k`/`f` then a secret prompt for the key or a visible one for the path (`validateHostedApiKey`), custom folder (`validateCustomMetadataDir` then `firstProblem(..., { rejectWarnings: false })` of `checkCustomMetadataDir`; a `warn` for an empty folder is accepted with a notice). Then the two follow-up questions, summary, create the DB directory, write `.env` via `renderEnvFile` (mode `0600` then `chmod`), close the prompt in a `finally`, then run the accepted follow-ups with the injected runners using answers-only env, then print the single closing ``Next:`` line. Map `PromptEndedError` as in Decisions 2. The prompt is created only on the interactive path (never touch `process.stdin` otherwise); remove the `process` stdin/stdout imports.
- [ ] **Step 6:** add an optional `input` argument to `runCli` in `tests/cli.test.ts` (`child.stdin?.end(input ?? '')`) and two CLI-level tests: all interactive answers piped in one write succeed; empty stdin exits 1 with no `.env` (today it exits 0 silently).
- [ ] **Step 7: verify** `npm run typecheck && npm run lint && npx vitest run tests/envFile.test.ts tests/setupInteractive.test.ts tests/prompt.test.ts tests/cli.test.ts`.

### Task 7: Docs and CHANGELOG

Depends on Task 6.

**Files:** `README.md` (Prerequisites line 28; Quick start lines 48–65 keeping the `## Quick start` heading), `llms-install.md` (sections 2–3 and a short hosted alternative), `CHANGELOG.md` (`[Unreleased]`, first `### Added` and first `### Changed` blocks), `.env.example` only if a generated line changes.

- [ ] **Step 1:** README Prerequisites line 28 covers both journeys. Quick start: two journeys (Local: `setup` then choose 1, then `doctor`/`index`/`serve` as `setup` offers; Hosted + custom: `setup`, choose 2, then `gateway`); keep the non-interactive block, add `--host 127.0.0.1` to it, add a hosted non-interactive example using `--hosted-api-key-file "$HOME/.d365/hosted-api-key"` and `--custom-dir`.
- [ ] **Step 2:** `llms-install.md` sections 2–3 use `setup --non-interactive --packages-dir "<PackagesLocalDirectory>" --api-key "$(openssl rand -hex 32)" --db-path "<absolute>/d365_index.db" --host 127.0.0.1` (the agent supplies the key so it can register it), then `doctor`, `index`, `serve`; keep both client JSON shapes (`mcpServers` with `X-API-Key`, VS Code `servers`); add a hosted-plus-gateway alternative; keep the write-tools-off line.
- [ ] **Step 3:** CHANGELOG bullets (backticked subject first, ~100-column wrap, 2-space continuation). Added: the two-mode interactive `setup` with per-answer checks and the new flags; `serve` printing the MCP URL and a paste-ready client entry; `doctor` ending with a `Next:` line; `index` showing a live counter on a terminal. Changed: interactive setup defaults to `MCP_HOST=127.0.0.1` (non-interactive without `--host` unchanged); `doctor` reports `workspace-capabilities` and an unconfigured Visual Studio workspace only when write tools or a workspace are configured; the packages-folder check no longer walks the whole tree and reports a sample path instead of a count; a hosted key with spaces or non-ASCII characters is now rejected by `gateway` config instead of at connection time.
- [ ] **Step 4:** the README mirror test from Task 6 passes; no markdown anchor `#quick-start` or `#cli-reference` is renamed.

### Task 8: Whole-change verification

- [ ] **Step 1:** `npm run typecheck && npm run lint` — clean, zero warnings.
- [ ] **Step 2:** `npm run build && npm run knowledge-check` — pass (`tests/mcpIntegration.test.ts` needs a fresh `dist`).
- [ ] **Step 3:** `npx vitest run` unsandboxed — compare against the clean baseline (1,234 passed, 0 failed, 1 skipped, 313 files); every new test file included.
- [ ] **Step 4:** adversarial review of the full diff against the spec and this plan (spec coverage, type consistency, secrets, Windows, the five Review Focus items); fix confirmed findings.
- [ ] **Step 5:** state plainly what was not verifiable here: a real terminal (raw mode, Ctrl-C, hidden input), Windows, and a real `PackagesLocalDirectory` timing.

---

## Execution notes: what changed while building

Recorded after implementation so the plan matches what shipped. The review in Task 8 Step 4 (seven reviewers,
every finding checked by two skeptics) produced the second group.

**Changes to the plan's decisions while building**

- `mode` in `SetupOptions` is a `string`, validated by `setupCommand` (the plan typed it `'local' | 'hosted'`),
  so a bad `--mode` can be refused with a message. Flag translation lives in `parseSetupFlags` in
  `src/cli/setup.ts`, because `src/index.ts` cannot be imported by a test.
- The follow-up questions are asked in the order they run: build the index first, then run the checks, so the
  checks judge the finished setup instead of warning that no index exists yet. (The spec and Task 6 listed
  the checks first.)
- Interactive path answers are also normalised for `~/`; the index DB path is written as typed.
- `setup --non-interactive` in local mode now also refuses an API key that `serve` would refuse (a
  `change-me` documentation placeholder). Recorded in the CHANGELOG.
- Every `setup` value flag is refused when bare (`--packages-dir`, `--api-key`, `--db-path`, `--transport`
  too, not only the new ones), because an unset shell variable leaves exactly that.
- `renderEnvFile` throws a typed `EnvFileError`. A value that needs quoting and ends in a backslash is refused:
  in quotes `dotenv` reads the closing quote as escaped and the value runs into the next entry.
- The prompt keeps its sink muted between questions, mutes inside the `line` handler, keeps no history, keeps
  the cursor after typed-ahead text, forgets typed-ahead keys after a rejected answer on a terminal, drops
  queued answers on Ctrl-C and forwards terminal resizes. Each has a test in `tests/prompt.test.ts`.
- `doctor` reports an unusable custom metadata folder as `custom-metadata-dir`, and `nextStep` takes an
  optional third argument so an unconfigured folder that already has a `.env` is not sent to a `setup` that
  refuses it.
- The `serve` key note names both places the key can come from, and `setup` says where a generated key was
  saved.

**Left as it is, on purpose**

- During `index` the structured logger still writes four JSON lines to stderr between the progress counter and
  the summary. They come from `buildIndex`, which `gateway` and `prepare-bundle` share; hiding them needs a
  logger hook, outside this change.
- Interactive setup ignores `--host`, `--api-key` and `--packages-dir` (it asks the questions instead).
- The checks run in-process from `setup` use an environment built from the answers, so a variable exported in
  the shell that would override the `.env` is not reflected.

**Not verifiable where this was built**

- A real terminal (raw mode, Ctrl-C, hidden input on an actual TTY) and Windows, including `windows-latest` CI.
  Both are covered by fake-terminal tests only.
- Timing of the packages-folder check on a full `PackagesLocalDirectory` over a cold NTFS volume.
