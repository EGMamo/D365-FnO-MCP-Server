# Deploy walkthrough: provisioning the hosted server from setup

Part 2c of "improve the hosted server experience". It builds on Part 2a ([two packages](2026-11-03-two-packages-design.md))
and Part 2b ([key administration](2026-10-25-hosted-connection-design.md)).

## What was asked

"Hosted ... also ask in this case if the azure server already there or want to deploy one and go through the
provisioning of the azure hosted mcp." The standard index comes only from the worker VM pulling sources from
Dataverse; never from a local `PackagesLocalDirectory`. Deploy shows the admin key once and creates the deployer's
developer key, so the deployer is connected at the end.

## Where it runs

`d365-fno-mcp-server setup --mode hosted --deploy` (or answering "No: deploy one now"). Operator package only.

The existing Azure tooling assumes a clone of the repository: `azure-deploy.ps1` and `azure-post-deploy.ps1` read
`infra/`, the worker builds from the GitHub repository, and the API image is built from the `Dockerfile`. The
walkthrough therefore runs from a clone. It looks for `infra/main.bicep` and `scripts/azure-deploy.ps1` beside the
package root; without them it stops with:
`The deploy walkthrough runs from a clone of the repository: git clone <repo>, then npm ci, npm run build, and
node dist/src/index.js setup --mode hosted --deploy.` (`<repo>` is the package's `repository` URL.)

## Steps

Every step prints what it is about to do. A failed step stops the walkthrough and prints the command to resume from
that step (the existing scripts are re-runnable).

1. **Checks.** `az version`, `pwsh -v` (PowerShell 7) and `az account show`. Missing tools are named with their install
   page. Not signed in: `Sign in first: az login (add --use-device-code if the browser sign-in is blocked).` The
   walkthrough never signs in for the user and never handles a password.
2. **Questions** (each checked as given; defaults in brackets):
   - subscription: picked from `az account list` [the current one];
   - region: picked from a short list [`northeurope`];
   - resource group [`rg-d365mcp-<env>`];
   - environment name [`dev`] (letters and digits, up to 8, as the template requires);
   - cost profile: `cheapest` (about $290 a month) or `standard` (about $470) [`cheapest` for names starting `dev`];
   - alert email (optional);
   - Dataverse URL `https://<org>.crm.dynamics.com` and the worker's application ID (a GUID).
   - GitHub repository `owner/name` that the worker and the Deploy workflow build from [the package's repository].
3. **Summary and confirmation.** All answers and the monthly cost, then `Deploy now? [y/N]`. Nothing in Azure changes
   before this yes. Non-interactive use needs `--yes` and every value as a flag.
4. **Infrastructure.** `pwsh scripts/azure-deploy.ps1 -SubscriptionId … -ResourceGroup … -Location …
   -EnvironmentName … -CostProfile … [-AlertEmail …] -Yes`. The script keeps its own what-if and its own prompt for the
   worker VM password (typed by the user into PowerShell, without echo).
5. **Post-deploy.** `pwsh scripts/azure-post-deploy.ps1 -ResourceGroup … -SubscriptionId … -Repository …
   -DataverseUrl … -WorkerApplicationId … -SmokeKeyOnly`. This keeps the script's own order: seed the deploy smoke key,
   store the worker's client secret (the script prompts for it without echo), set up and prepare the worker, run the
   first acquisition on the worker, resume the schedule, the GitHub trust and the Deploy workflow that builds and
   ships the API image. `-SmokeKeyOnly` is new: `SeedApiKeys` stores only `ci-smoke`, so no developer key is created
   outside the registry.
6. **Ready.** Read the web app host from the deployment outputs (`az deployment group show`), then poll
   `https://<host>/health` until ready (up to 30 minutes, every 15 seconds, with the elapsed time shown).
7. **Keys.** `keys reset-admin --registry azure-blob --account-url <artifactAccountUrl>` (the deployer's Azure sign-in
   has the data role on the `d365-keys` container through the template), shown once with
   `Save this admin key now. It manages developer keys and is not shown again.` Then create the deployer's developer
   key through the admin API (name asked [the local user name]).
8. **Connect.** Continue as hosted-yes with the URL and that key already filled in: custom-models folder, `.env`,
   `doctor`. It ends with the command other developers run:
   `d365-fno-mcp setup --mode hosted --hosted-url https://<host>/mcp` and `Create their keys with: d365-fno-mcp-server
   keys new <name> --server https://<host>`.

## Template and script changes

- `infra/modules/storage.bicep`: the deployer is not given a data role by the template today. `azure-deploy.ps1` gains
  nothing; instead step 7 grants the signed-in user Storage Blob Data Contributor on the `d365-keys` container
  (`az role assignment create`, scoped to the container) before `reset-admin`, and says so. Role propagation can take
  minutes, so `reset-admin` retries a 403 for up to 5 minutes.
- `scripts/azure-post-deploy.ps1`: `-SmokeKeyOnly`.

## Components

`src/cli/deploy.ts` (the questions and orchestration), `src/cli/deployRunner.ts` (runs a command with inherited
stdio for the PowerShell scripts, captured for `az`, injectable), `src/cli/setup.ts` (hand-off), `src/index.ts`
(passes the deploy runner in the operator edition), `scripts/azure-post-deploy.ps1`, README and
`docs/hosted-deployment.md`.

## Testing

With a fake command runner and a fake HTTP server, no Azure:

- missing `az`, missing `pwsh`, not signed in: fixed messages, nothing else runs;
- not a clone: the fixed message;
- question validation (environment name, Dataverse URL, GUID, email) and defaults;
- the exact `pwsh` and `az` argument lists for the answers; nothing runs before the confirmation; `--yes` with flags
  runs non-interactively; a missing flag non-interactively is a usage error;
- a failed step stops and prints the resume command;
- `/health` polling: ready, slow then ready, timeout;
- reset-admin and the developer key: the admin key printed once, the developer key written to `.env` only, neither in
  any log line;
- the developer edition still only prints the operator command.

## Verified later

A real end-to-end run on the user's Azure subscription (asked first, because it creates billable resources including
the worker VM), deleting the resource group afterwards.

## Out of scope

Pausing and resuming (existing `azure-pause.ps1`), redeploying an existing environment (the scripts already handle it;
the walkthrough is for a first deployment), a non-Azure host.
