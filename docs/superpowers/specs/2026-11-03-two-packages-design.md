# Two packages: one for operators, one for developers

Part 2a of "improve the hosted server experience". It comes before Part 2b
([hosted connection](2026-10-25-hosted-connection-design.md): clear errors, key rotation, `keys new`), because `keys new`
must be operator-only from its first commit. Part 1 (`GET /status` and friends) is committed.

## What was asked, and decided

The user asked for two deployment packages: a server or operator solution, and a client or developer solution, with
`keys new` in the operator one only. Then, for the developer package, the installer asks which of two ways to work:

- **A. Only custom code.** Only the developer's custom models are indexed, in the same process that answers (no hosted
  server).
- **B. A hosted MCP server and custom code.** The hosted server supplies the standard application; the custom models
  are still indexed locally.

Confirmed readings of that:

1. "Same process" means the gateway process indexes the custom models itself. There is no separate `index` step. The
   gateway already works this way.
2. In A, standard objects are simply unknown. Tools that need them are not offered, or say so clearly.
3. Indexing a full `PackagesLocalDirectory` is operator-only. Anyone who wants that installs the operator package.

## Who installs what

| | Operator package | Developer package |
| --- | --- | --- |
| For | Whoever runs a server: the Azure API and worker, or a person who runs one on their own machine | A developer who connects to a hosted server, or works on custom code alone |
| npm name, command | `d365-fno-mcp-server` (as today) | `d365-fno-mcp-client`, `d365-fno-mcp` |
| Also shipped as | The Docker image of the hosted API | The Visual Studio extension drives the gateway; it keeps calling `d365-fno-mcp-server gateway` until sub-project 4 moves it |
| Commands | everything it has today, plus `keys new` (Part 2b) | `setup`, `gateway`, `doctor`, `help`, `version` |
| Not in it | nothing is removed | `serve`, `index`, `index-status`, `index-xref`, `index-trace`, `index-release-plans`, `index-docs`, `index-bp`, `digest`, `acquire`, `prepare-bundle`, `artifact`, `fetch-model`, `knowledge-check`, `keys` |
| Third-party packages | as today | `@modelcontextprotocol/sdk`, `dotenv`, `express`, `express-rate-limit`, `fast-xml-parser`, `glob`, `yaml`, `zod` |
| Left out of the developer install | | `@azure/identity`, `@azure/storage-blob` (about 67 MB), `onnxruntime-web` (about 139 MB), `@huggingface/tokenizers`, and the 87 MB embedding model that `fetch-model` downloads |

Both packages carry the same version. The gateway and the hosted server compare major and minor versions, and that
check does not change. The operator package stays a superset, so existing installs, the extension and every document
that says `d365-fno-mcp-server gateway` keep working.

Who may issue access is not decided by a package: a hosted server honours only the keys in its own list, and that list
changes only for whoever can write the Key Vault secret or the keys file. The packages decide what is installed and
visible, so a developer's install has nothing that looks like key issuing.

## One source tree, two entry points

Nothing moves between folders and no test import changes.

- **`src/clientIndex.ts`** is the developer entry point (bin `d365-fno-mcp`). It loads `.env` like `src/index.ts`, then
  dispatches `setup`, `gateway`, `doctor`, `help` and `version`. Any other word prints the developer help and exits 1.
  `src/index.ts` stays the operator entry point.
- **Help.** `HELP_TEXT` in `src/cli/args.ts` stays the operator help (the README's CLI block must equal it). A new
  `CLIENT_HELP_TEXT` in `src/cli/clientArgs.ts` describes the five developer commands only.
- **Editions.** `setupCommand` and `doctorCommand` take an edition from the entry point:
  `{ bin: string; modes: SetupMode[]; local?: LocalSetup }`. The operator entry passes `bin: 'd365-fno-mcp-server'`,
  all three modes and the local-mode flow; the developer entry passes `bin: 'd365-fno-mcp'`, modes `custom-only` and
  `hosted`, and no local flow. The local-mode questions, `.env` writer and follow-ups move from `src/cli/setup.ts` into
  `src/cli/setupLocal.ts`, which only the operator entry imports. (It must be passed in, not imported lazily from
  `setup.ts`: the compiler follows dynamic imports too, so a lazy import would put it back in the developer build.)
  With the developer edition `doctor` runs the gateway checks and none of the `serve` checks.
- **Shared types stay shared.** The `ApiKeySource` interface that `httpTransport.ts` accepts (Part 2b) is declared in
  `src/server/apiKeys.ts`; its file-reloading implementation lives in `src/server/apiKeyStore.ts`, which only the
  operator build reaches. A type-only import still pulls a file into the program, so this matters.
- **Build.** `tsconfig.client.json` extends `tsconfig.build.json` with `files: ["src/clientIndex.ts"]` and
  `outDir: "dist-client"`. The compiler then emits exactly the modules that entry point reaches (62 of the 102 source
  files today, with no server start-up, configuration loader, artifact store, Azure code or knowledge filter).
  `npm run build:client` runs it.
- **Pack.** `scripts/pack-client.mjs` (`npm run pack:client`) writes `dist-client/package.json`: the name and bin above,
  the root version, `engines` copied from the root, and `dependencies` computed from the bare imports found in
  `dist-client` with their versions taken from the root `package.json`. The list cannot be written by hand and drift.
  It also copies `LICENSE`, `agents/` and a short developer README (`docs/client-readme.md`), then runs `npm pack`.
  The operator package is packed as today.

## The installer question

`d365-fno-mcp setup` (developer package) asks how it will be used and checks each answer as it is given, as the
operator `setup` does:

1. **Only custom code** (`--mode custom-only`). It asks for the folder with the custom models (checked for AOT folders)
   and, optionally, where to keep the local index (default: beside the folder's state). It asks for no URL, no key and no
   port. It writes `.env` with `D365_CUSTOM_METADATA_DIR` and the index path, offers `doctor`, and ends with
   `Start it with: d365-fno-mcp gateway`.
2. **A hosted server and custom code** (`--mode hosted`). Exactly today's hosted flow: the MCP URL, the key (typed or
   from a file) and the custom folder.

The operator `setup` offers three choices: build the full index here (`local`), hosted, and custom-only. Non-interactive
use needs `--mode` and `--custom-dir` for custom-only. A flag that belongs to another mode is refused by name, as now,
and a local-mode flag given to the developer package says it belongs to the operator package. Generated `.env` headers
and every printed next step use the edition's command name.

## The gateway without a hosted server

Custom-only is a state of the gateway, not a flag on the side:

- **Configuration.** `D365_HOSTED_MCP_URL` becomes optional. Empty means custom-only. A key without a URL is an error
  (`D365_HOSTED_API_KEY is set but D365_HOSTED_MCP_URL is empty`), so a half-written hosted setup is not mistaken for
  custom-only. `GatewayConfig.hostedUrl` and `hostedApiKey` become `string | null`.
- **Upstream.** A `NoUpstream` implements the existing `UpstreamPort` with `configured: false`. The router and the
  hosted tool catalogue treat "not configured" differently from "unavailable": no outage warnings, no
  `[hosted unavailable]` prefixes, no retries.
- **Tools.** Merge tools answer from the custom index alone, without a warning. Tools that only the hosted server can
  answer (`get_index_stats`, the security, best-practice and similar forward-only tools) are not offered. If one is
  called anyway, the answer is an error that says this gateway has no hosted server and the tool needs one.
- **Standard objects.** A lookup or generator that names an object the custom index does not hold answers "not found in
  the custom index" plus one fixed hint: custom-only mode does not index the standard application; use a hosted server
  (`d365-fno-mcp setup --mode hosted`). Generators still fail closed rather than emit code for objects that do not exist.
- **Optional standard index.** `D365_GATEWAY_STANDARD_INDEX_DB_PATH` keeps working with no hosted server: an index file
  built by an operator lets the gateway answer standard-object questions locally. It is not a setup choice.
- **Self-description.** The session instructions say the gateway runs on custom models only. `local_index_status` reports
  `hosted: { configured: false }`.
- **`doctor`.** Without a hosted URL the gateway checks skip the hosted ones and show one row,
  `gateway-hosted: custom-only, no hosted server configured` (a pass).

## Components

- New: `src/clientIndex.ts`, `src/cli/clientArgs.ts`, `src/cli/setupLocal.ts`, `tsconfig.client.json`,
  `scripts/pack-client.mjs`, `docs/client-readme.md`, `tests/packageBoundary.test.ts`, `tests/clientCli.test.ts`
  (`tests/clientEntry.test.ts` already exists for the printed client entry).
- Changed: `src/cli/setup.ts` (editions, custom-only, local flow moved out), `src/cli/doctor.ts` (edition),
  `src/gateway/config.ts`, `src/gateway/types.ts`, `src/gateway/server.ts`, `src/gateway/router.ts`,
  `src/gateway/upstream.ts` (the `NoUpstream`), `src/gateway/localTools.ts` (instructions, `local_index_status`),
  `src/index.ts` (passes the operator edition), `package.json` (scripts), README (installation and quick start per
  audience), `llms-install.md`, `CHANGELOG.md`.

## Rules this keeps

- Validate settings and input with zod; no `any`; named exports; tool annotations kept on every tool.
- Secrets appear in no output; messages name the setting.
- Write tools stay off by default and no example enables them.
- `serverStatus.ts` and the gateway still do not import `src/config.ts`, `configLoader.ts` or `server/start.ts`.

## Testing

- **Boundary (`tests/packageBoundary.test.ts`).** Build the program for `src/clientIndex.ts` with the TypeScript
  compiler API and list its source files: none is on the operator-only list (`src/index.ts`, `server/start.ts`,
  `server/apiKeyStore.ts`, `config.ts`, `configLoader.ts`, `cli/setupLocal.ts`, `cli/keys.ts`, every `cli/*-command.ts`
  file, `cli/digest.ts`, everything under `knowledge/`, and `indexer/artifact*.ts` and `indexer/azureBlobArtifactStore*.ts`); no bare import is `@azure/*`, `onnxruntime-web`, `@huggingface/*` or `mssql`; every
  bare import is a root dependency. A new file that reaches an operator module through any import fails the test.
- **Pack.** Build into a temporary folder; the generated `package.json` has the bin `d365-fno-mcp` only, the same version
  as the root, and dependencies equal to the bare imports. `npm pack --dry-run` lists no operator file. The built entry
  point answers `--version` and `help` (only the five commands) and exits 1 on `serve`, `artifact` and `keys`.
- **Editions.** `parseSetupFlags` and `setupCommand` with each edition: modes offered, flags refused, `.env` headers and
  next steps use the right command name; custom-only writes the expected `.env`, never a URL or key; interactive and
  non-interactive.
- **Custom-only gateway** (extends the gateway integration tests with a stack that has no hosted URL): the tool list is
  the local tools only and carries no `[hosted unavailable]`; merge tools answer without warnings; a forward-only tool is
  absent and, if called, answers the fixed error; a standard object gives the fixed hint; `local_index_status` shows
  `configured: false`; a key without a URL is a configuration error; the custom index still refreshes when files
  change; with `D365_GATEWAY_STANDARD_INDEX_DB_PATH` standard objects resolve. A hosted stack behaves exactly as before.
- **`doctor`** custom-only row and no hosted rows; the developer edition runs no `serve` check.
- Typecheck, lint with no warnings, build, `build:client`, and the full suite pass.

## Out of scope

A CI release workflow for the developer package (it needs a CI run to verify), publishing to npm, moving the Visual Studio
extension to the new command (sub-project 4), the documentation rewrite (sub-project 3), a developer-package Docker image.

## Not verifiable here

Installing the packed developer tarball on Windows, and the Visual Studio extension running it.
