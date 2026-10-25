# First-run setup experience — design

Sub-project 1 of 4 under "improve the user experience". The others are the assistant-facing tool
responses, the docs and onboarding rewrite, and the Visual Studio extension; each gets its own spec.

## Intent

A developer goes from a fresh clone to an assistant making a successful tool call without reading
the configuration table or guessing the next command. This covers both journeys the project has:

- **Local:** build the index here from `PackagesLocalDirectory`, then `serve`.
- **Hosted + custom:** use a hosted server and index only the developer's custom models here, then
  `gateway`.

Success: a new developer can run `setup`, answer questions that are checked as they are answered, and
finish with a running server and a client entry they can paste, with no step that fails only later.

## Problems in the current code

- `serve` logs `MCP server ready` as a structured line and never prints the URL or a client entry.
  The gateway already does (`printClientEntry`, `src/gateway/server.ts`).
- `setup` covers local mode only. It hard-codes `MCP_PORT=3000`, never writes `MCP_HOST` (the server
  then binds every interface), and the gateway's three required variables are set by hand.
- `setup` validates late: a wrong packages path is only a warning, and a short API key is rejected
  after every prompt has been answered.
- `doctor` reports `workspace-capabilities` as a hard-coded `warn` carrying a JSON blob, so a healthy
  machine always shows a warning, and it ends without saying what to do next.
- `index` shows nothing readable while it runs (progress is a structured log line); the summary
  appears only at the end.

## Design

### Flow

`setup` asks first how the tool will be used, then branches.

```text
How will you use it?
  1) Build the index here from PackagesLocalDirectory
  2) Use a hosted server, and index only my custom models here
```

Local mode asks, in order, and checks each answer before moving on (a failed check re-asks):

1. `PackagesLocalDirectory` path: exists, is a directory, holds D365 metadata XML (the check
   `doctor` runs).
2. API key, blank to generate: at least 32 characters. Typed input is not echoed.
3. Index DB path, default `./d365_index.db`.
4. Bind to this machine only, default yes: writes `MCP_HOST=127.0.0.1`.

Hosted mode asks:

1. Hosted MCP URL: the gateway's own rules (https, or http only on loopback; no credentials in the URL).
2. Hosted API key, hidden, or a key file path (`D365_HOSTED_API_KEY` / `D365_HOSTED_API_KEY_FILE`;
   exactly one).
3. Custom models folder: readable and laid out as `<Package>/<Model>/Ax<Type>/*.xml` (the check
   `doctor` runs).

Then `setup` writes `.env` once, owner-only, and offers follow-ups:

- "Run the checks now?" runs `doctor` in-process.
- "Build the index now?" (local mode only) runs `index` with a progress line.
- It ends with the command to start (`serve` or `gateway`).

### Compatibility

- `setup --non-interactive` without a mode behaves exactly as today (local mode, no `MCP_HOST`
  unless `--host` is passed). Existing flags and tests are unchanged.
- New flags: `--mode local|hosted`, `--host`, and for hosted mode `--hosted-url`, `--hosted-api-key`
  or `--hosted-api-key-file`, and `--custom-dir`. `--mode hosted --non-interactive` requires them.
- The interactive default of binding `127.0.0.1` is the one deliberate behaviour change. It matches
  the advice in `.env.example`. A developer running `serve` on a remote VM answers "n".

### Startup output

`serve` (not hosted artifact mode) prints the MCP URL and a paste-ready client entry once it is
listening. The entry has the same shape as the gateway's: server name `d365-fno`, type `http`, URL
`http://<host>:<port>/mcp` (`localhost` when the server binds every interface), and an
`Authorization: Bearer ${input:...}` header whose value the client prompts for. The key is never
printed. The server accepts both `Authorization: Bearer` and `X-API-Key`.

### Components

- `src/cli/prompt.ts` (new): readline wrapper with `ask(question, { validate, secret, default })`,
  which re-asks until `validate` accepts, mutes echo for secrets, and takes injectable input and
  output streams so tests can drive it. No new dependency. End of input rejects, and `setup` turns
  that into exit 1 with nothing written.
- `src/cli/checks.ts` (new): the packages-dir and custom-folder checks, moved out of `doctor.ts` so
  `doctor` and `setup` import the same functions and cannot disagree.
- `src/gateway/config.ts`: export the existing hosted URL and hosted key validators. Gateway code
  still must not import `src/config.ts`; `setup` importing the gateway's config module is allowed
  (`doctor` already does).
- `src/cli/setup.ts`: `collectLocal`, `collectHosted`, a renderer per mode, and `setupCommand`
  orchestrating mode, collection, writing and follow-ups. Follow-up runners are injected for tests.
- `src/utils/clientEntry.ts` (new): builds the client-entry object and its printed form. The
  gateway's `printClientEntry` and `serve` both use it; the gateway keeps its own token wording.
- `src/cli/doctor.ts`: show `workspace-capabilities` only when write tools or a Visual Studio
  workspace are configured, and end with a `Next:` line derived from the results (no index yet means
  run `index`; all clear means `serve` or `gateway`).
- `src/indexer/buildIndex.ts`: optional `onProgress` callback; existing callers are unaffected.
  `indexCommand` draws a one-line counter only when stdout is a terminal.

### Error handling

- A failed check in interactive mode re-asks with the reason and, where useful, an example.
- `.env` is written only after every answer is valid. It holds the secrets the developer entered
  (`MCP_API_KEY` as today; the hosted key in hosted mode, unless they gave a key file path instead),
  at the same owner-only permissions.
- If an offered `doctor` or `index` step fails, `.env` stays, the failure prints with the command to
  retry, and `setup` still exits 0, because its own job succeeded.
- Secrets never appear in prompts, echo, summaries or errors.

## Testing

All with vitest, mostly in `tests/cli.test.ts` and new files beside it.

- Prompt helper: re-asks on a failed check, mutes secret echo, rejects at end of input.
- `setup` interactive in both modes: valid first try; bad answer then good; end of input writes no
  `.env`; the typed secret is absent from output.
- `setup --non-interactive`: existing tests unchanged; new tests for `--mode hosted` and `--host`.
- Client entry: rendering, and `serve` printing it once listening; existing gateway tests still pass.
- `doctor`: a healthy environment gives zero warnings and a `Next:` line; `workspace-capabilities`
  appears when write tools or a workspace are configured.
- `index`: the progress callback is called; no counter is drawn when stdout is not a terminal.
- `npm run typecheck`, `npm run lint` and `npm test` pass.

## Docs touched

Only what this changes: the README Quick start, `llms-install.md`, the `--help` text for `setup`
and the CHANGELOG `[Unreleased]` section. Restructuring the README belongs to the docs sub-project.

## Out of scope

- A port-in-use probe in `setup`.
- Auto-detecting `PackagesLocalDirectory`.
- Setup for hosted artifact / Azure deployments.
- Visual Studio extension changes.
- Tool-response and error-message changes (sub-project 2).
- Restructuring the README (sub-project 3).

## Details to settle while implementing

- Check whether any test asserts the always-present `workspace-capabilities` result before changing it.
- Confirm the server-name constant `d365-fno` is shared between the gateway entry and the `serve`
  entry so a pasted entry replaces the old one instead of adding a second.
