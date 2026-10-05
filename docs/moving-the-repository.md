# Moving the repository to another owner or organization

What depends on the GitHub owner and repository name, and the steps for a transfer. GitHub
redirects the old web and git URLs after a transfer, but Azure's GitHub sign-in does not follow
redirects: the deploy identity trusts tokens by subject, and the subject changes with the owner.

## What depends on the owner and name

| Where | What | After a transfer |
| --- | --- | --- |
| Azure, deploy identity `id-deploy-<workload>-<env>` | Federated credential `github-production`, subject `repo:<owner>/<name>:environment:production`, created by `infra/main.bicep` from `githubRepository` | Stops matching. Rerun `azure-deploy.ps1` from a clone whose `origin` points at the new location; it updates the subject in place |
| Azure, same identity | Any federated credential added by hand with the ID-based subject `repo:<owner>@<owner-id>/<name>@<repo-id>:environment:production` | Stops matching: the owner ID changes (the repository ID does not). Delete it and add it again with the new owner ID |
| `scripts/azure-deploy.ps1 -GitHubRepository`, `scripts/azure-post-deploy.ps1 -Repository` | Repository for the federated subject, the worker's source download, the `production` environment and the Deploy run | Default to the `origin` remote (`scripts/Get-GitHubRepository.ps1`), so update the remote and nothing else |
| `infra/main.bicep` `githubRepository` | Template default for direct `az deployment` runs | Pass the new value, or let the script pass it |
| GitHub environment `production` | Secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `MCP_SMOKE_API_KEY`; variables `RESOURCE_GROUP`, `WEBAPP_NAME`, `ACR_NAME` | Check they arrived; if not, `azure-post-deploy.ps1 -Step GitHub` recreates them (it asks for the `ci-smoke` key) |
| Worker VM | `SetupWorker` downloads `https://github.com/<owner>/<name>/archive/<commit>.zip` and resolves the commit through the public GitHub API | Works through the redirect, but pass or detect the new name. A private repository needs a different download path, since these calls are anonymous |
| Workflows | `deploy.yml` and `ci.yml` use no owner name; `release-vs-extension.yml` uses `github.repository`; images go to Azure Container Registry, not GHCR | Nothing to change |
| Docs | Clone URL in `llms-install.md`, releases link in `docs/visual-studio-extension.md`, `maintainers` in `glama.json` (a person, not the owner) | Update the first two after the transfer |
| Outside the repository | Local clones, the Claude GitHub App installation and project settings, branch protection, any webhooks or deploy keys | See the checklist |

## Checklist

Before the transfer:

1. Make sure no Deploy run or acquisition is in progress.
2. Note the environments, secrets and variables under Settings > Environments > `production`, so
   you can tell whether they arrived.
3. Check that you can create repositories in the target organization, and that its Actions policy
   allows the actions the workflows use (`actions/*`, `azure/login`, `docker/*`).

Transfer in Settings > General > Danger Zone > Transfer ownership.

After the transfer:

1. In every local clone: `git remote set-url origin https://github.com/<new-owner>/<name>.git`.
2. Look up the new owner ID: `gh api orgs/<new-owner> --jq .id` (`users/<login>` for a personal
   account). The repository ID is unchanged: `gh api repos/<new-owner>/<name> --jq .id`.
3. Update the deploy identity, for each environment that is deployed:
   `./scripts/azure-deploy.ps1 -ResourceGroup <group> -EnvironmentName <env>` updates the
   `github-production` subject. For a paused environment this also resumes it, so if you want it to
   stay paused, update the credential by hand instead:
   `az identity federated-credential update -g <group> --identity-name id-deploy-<workload>-<env> -n github-production --issuer https://token.actions.githubusercontent.com --subject repo:<new-owner>/<name>:environment:production --audiences api://AzureADTokenExchange`.
4. Replace any ID-based credential:
   `az identity federated-credential list -g <group> --identity-name id-deploy-<workload>-<env> -o table`,
   delete the one whose subject contains `@`, and create it again with the new owner ID.
5. Check the `production` environment's secrets and variables; if any are missing, run
   `./scripts/azure-post-deploy.ps1 -ResourceGroup <group> -Step GitHub`.
6. Install the Claude GitHub App on the new owner and update the repository in any project or tool
   that points at it.
7. Update the links: replace `EGMamo/D365-FnO-MCP-Server` with the new path in `llms-install.md`
   and `docs/visual-studio-extension.md`.
8. Run the Deploy workflow once (or `azure-post-deploy.ps1 -Step Deploy`) to prove the Azure sign-in
   works.
