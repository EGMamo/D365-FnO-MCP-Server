# Two packages, and the install question: local or hosted

Part 2a of "improve the hosted server experience". Part 2b ([key administration](2026-10-25-hosted-connection-design.md))
and Part 2c ([deploy walkthrough](2026-11-08-deploy-walkthrough-design.md)) build on it. Part 1 (`GET /status` and
friends) is committed.

## What was asked, and decided

In the user's words:

- "There should be 2 deployment package, 1 server solution or operator solution and one for client or developer
  solution, and the keys new command should be on the operator solution."
- "While installing should ask if it will be only local which means it won't use an azure hosted mcp, only mcp grounded
  in the custom code. Or hosted which means it uses custom code grounded and also an azure hosted mcp, and also ask in
  this case if the azure server already there or want to deploy one and go through the provisioning."
- Building the standard index locally "should never happen": "local indexing only ever covers custom code". The
  standard index is built only by the Azure worker VM, from Dataverse.

Confirmed readings:

1. Local means the gateway process indexes the custom models itself. There is no separate `index` step.
2. In local mode standard objects are unknown. Tools that need them are not offered, or say so clearly.
3. Developers never create keys (Part 2b), and only the operator package can deploy (Part 2c).

## Who installs what

| | Operator package | Developer package |
| --- | --- | --- |
| For | Whoever deploys and runs the hosted server | A developer: local only, or connecting to a hosted server |
| npm name, command | `d365-fno-mcp-server` (as today) | `d365-fno-mcp-client`, `d365-fno-mcp` |
| Also shipped as | The Docker image of the hosted API | The Visual Studio extension keeps calling `d365-fno-mcp-server gateway` until sub-project 4 |
| Commands | everything it has today except a full local index, plus `keys` (2b) and the deploy walkthrough (2c) | `setup`, `gateway`, `doctor`, `help`, `version` |
| Third-party packages | as today | `@modelcontextprotocol/sdk`, `dotenv`, `express`, `express-rate-limit`, `fast-xml-parser`, `glob`, `yaml`, `zod` (computed, not hand-written) |
| Left out | | `@azure/*`, `onnxruntime-web`, `@huggingface/*`, `mssql`, the embedding model |

Both carry the same version. The operator package stays a superset of the developer commands, so existing installs
and every document that says `d365-fno-mcp-server gateway` keep working.

## One source tree, two entry points

- **`src/clientIndex.ts`** is the developer entry point. It loads `.env` like `src/index.ts`, then dispatches the five
  developer commands; any other word prints the developer help and exits 1. `src/index.ts` stays the operator entry.
- **Help.** `HELP_TEXT` in `src/cli/args.ts` stays the operator help (the README CLI block must equal it).
  `CLIENT_HELP_TEXT` in `src/cli/clientArgs.ts` lists the five developer commands.
- **Editions.** `setupCommand` and `doctorCommand` take `edition: { bin: string; deploy?: DeployRunner }` from the
  entry point. The operator entry passes `bin: 'd365-fno-mcp-server'` and the deploy walkthrough (2c); the developer
  entry passes `bin: 'd365-fno-mcp'` and no deploy. It is passed in, never imported lazily from `setup.ts`, because
  the compiler follows dynamic imports.
- **Build.** `tsconfig.client.json` extends `tsconfig.build.json` with `files: ["src/clientIndex.ts"]`,
  `outDir: "dist-client"`. `npm run build:client`.
- **Pack.** `scripts/pack-client.mjs` (`npm run pack:client`) writes `dist-client/package.json` (name, bin, root
  version and `engines`, `dependencies` computed from the bare imports under `dist-client` with root versions), copies
  `LICENSE`, `agents/` and `docs/client-readme.md` as its README, and runs `npm pack`.

## The install question

`setup` asks, in both packages:

```
How will you use it?
  1) Local only: index my custom models here. No hosted server.
  2) Hosted: a hosted server for the standard application, plus my custom models indexed here.
```

- **Local** (`--mode local`). It asks for the custom-models folder (checked for AOT folders; an empty folder is
  allowed with a note) and, optionally, the local index path. No URL, no key, no port. It writes `.env` with
  `D365_CUSTOM_METADATA_DIR` (and the index path when given), offers `doctor`, and ends with
  `Start it with: <bin> gateway`.
- **Hosted** (`--mode hosted`). It then asks:

  ```
  Is the hosted server already deployed?
    1) Yes: I have its URL and a developer key.
    2) No: deploy one now.
  ```

  - **Yes** (`--hosted-url`): today's hosted flow (URL, developer key typed or from a file, custom folder).
  - **Deploy** (`--deploy`): in the operator package, the walkthrough of Part 2c, which ends by writing the same
    hosted `.env`. In the developer package it prints, and exits 1 non-interactively:
    `Deploying a hosted server needs the operator package and Owner (or Contributor and User Access Administrator) on
    the Azure subscription. Run: npx d365-fno-mcp-server setup --mode hosted --deploy`

The old local mode (`D365_PACKAGES_PATH`, `D365_INDEX_DB_PATH`, the generated API key, the offer to build the index)
is gone. Its flags (`--packages-path`, `--db-path`, `--host`, `--port`, `--api-key`) are refused with:
`<flag> is no longer supported: setup no longer builds a full local index. Use --mode local (custom models only) or
--mode hosted.` Non-interactive local needs `--custom-dir`. Without `--mode`, non-interactive use is an error naming
both modes (it used to default to the old local mode).

## No full local index

- `index` (the full `PackagesLocalDirectory` pass) refuses with exit 1:
  `Full local indexes are no longer supported. Local mode indexes only your custom models (setup --mode local); the
  standard application comes from a hosted server, whose worker builds the index in Azure.`
  `runIndexPass` stays: `prepare-bundle` on the worker uses it.
- `npm run index` and the README sections that build a full local index are removed; the README quick start becomes
  "Local" and "Hosted".
- `serve` is unchanged: it serves the index it is given, which on Azure is the worker's bundle.
- The gateway's existing `D365_GATEWAY_STANDARD_INDEX_DB_PATH` is not offered by `setup` and not documented as a
  local option; the setting keeps working for anyone who already uses it.

## The gateway without a hosted server

- **Configuration.** `D365_HOSTED_MCP_URL` becomes optional; empty means local mode. A key without a URL is an error
  (`D365_HOSTED_API_KEY is set but D365_HOSTED_MCP_URL is empty`). `GatewayConfig.hostedUrl` and `hostedApiKey`
  become `string | null`.
- **Upstream.** `NoUpstream` implements `UpstreamPort` with `configured: false`. "Not configured" is not "unavailable":
  no outage warnings, no `[hosted unavailable]` prefixes, no retries.
- **Tools.** Merge tools answer from the custom index alone, without a warning. Forward-only tools are not offered; a
  call anyway answers `This gateway runs in local mode (custom models only); <tool> needs a hosted server. Run
  <bin> setup --mode hosted.`
- **Standard objects.** A lookup that misses adds the fixed hint: `Local mode indexes only your custom models; standard
  objects need a hosted server (setup --mode hosted).` Generators still fail closed.
- **Self-description.** The session instructions say the gateway runs on custom models only. `local_index_status`
  reports `hosted: { configured: false }`.
- **`doctor`.** Without a hosted URL the hosted checks are replaced by one passing row
  `gateway-hosted: local mode, no hosted server configured`.

## Rules this keeps

zod for settings and input; no `any`; named exports; tool annotations; secrets in no output; write tools off;
`serverStatus.ts` and the gateway still do not import `src/config.ts`, `configLoader.ts` or `server/start.ts`.

## Testing

- **Boundary (`tests/packageBoundary.test.ts`).** The TypeScript program for `src/clientIndex.ts` contains none of:
  `src/index.ts`, `server/start.ts`, `server/keyRegistry*.ts`, `server/adminRoutes.ts`, `config.ts`,
  `configLoader.ts`, `cli/keys.ts`, `cli/deploy*.ts`, every `cli/*-command.ts`, `cli/digest.ts`, `knowledge/`,
  `indexer/artifact*.ts`, `indexer/azureBlobArtifactStore*.ts`; no bare import of `@azure/*`, `onnxruntime-web`,
  `@huggingface/*`; every bare import is a root dependency or an optional one. (`mssql` is reached through the
  cross-reference code as an optional, lazily loaded driver that fails with a clear message; the pack script
  leaves optional dependencies out.)
- **Pack.** The generated `package.json` has the bin `d365-fno-mcp` only, the root version, and dependencies equal to
  the bare imports; the built entry answers `--version` and `help` and exits 1 on `serve`, `keys`, `index`.
- **Setup.** Both editions: the two questions, local writes no URL or key, hosted-yes as before, deploy in the
  developer edition prints the operator command, old local flags refused by name, non-interactive without `--mode`
  fails; `.env` headers and next steps use the edition's command.
- **`index`** exits 1 with the fixed text.
- **Local gateway.** Local tools only, no `[hosted unavailable]`, merge tools without warnings, a forward-only call
  gets the fixed error, a standard miss gets the hint, `local_index_status.hosted.configured === false`, key without
  URL is a configuration error, the custom index refreshes; a hosted stack behaves as before.
- **`doctor`** local row; the developer edition runs no `serve` check.
- Typecheck, lint, build, `build:client`, full suite.

## Out of scope

Publishing to npm and a release workflow, moving the Visual Studio extension (sub-project 4), the documentation
rewrite (sub-project 3).

## Not verifiable here

Installing the packed developer tarball on Windows, and the Visual Studio extension running it.
