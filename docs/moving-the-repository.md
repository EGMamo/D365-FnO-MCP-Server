# Moving the repository to another owner or organization

What depends on the GitHub owner and repository, and the steps for a transfer. GitHub redirects
the old web and git URLs after a transfer, but Azure's GitHub sign-in does not follow redirects:
the deploy identity trusts tokens by subject, and the subject contains the owner's name and ID.

## What depends on the owner and name

| Where | What | After a transfer |
| --- | --- | --- |
| Azure, deploy identity `id-deploy-<workload>-<env>` | Federated credential `github-production`, added by `scripts/azure-github-trust.ps1` (the template creates none). Subject `repo:<owner>@<owner-id>/<name>@<repo-id>:environment:production` | Stops matching: the owner name and ID change, the repository ID does not. Run `azure-github-trust.ps1` again from a clone of the new location |
| `azure-github-trust.ps1 -Repository`, `azure-post-deploy.ps1 -Repository`, `azure-deploy.ps1 -GitHubRepository` | Repository to trust, the worker's source download, the `production` environment and the Deploy run | Default to the `origin` remote (`scripts/Get-GitHubRepository.ps1`), so update the remote and nothing else |
| GitHub environment `production` | Secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `MCP_SMOKE_API_KEY`; variables `RESOURCE_GROUP`, `WEBAPP_NAME`, `ACR_NAME` | Check they arrived; if not, `azure-post-deploy.ps1 -Step GitHub` recreates them (it asks for the `ci-smoke` key) |
| Worker VM | `SetupWorker` downloads `https://github.com/<owner>/<name>/archive/<commit>.zip` and resolves the commit through the public GitHub API | Uses the new name from the remote. A private repository needs another download path, since these calls are anonymous |
| Workflows | `deploy.yml` and `ci.yml` name no owner; `release-vs-extension.yml` uses `github.repository`; images go to Azure Container Registry, not GHCR | Nothing to change |
| Docs | Clone URL in `llms-install.md`, releases link in `docs/visual-studio-extension.md`, `maintainers` in `glama.json` (a person, not the owner) | Update the first two after the transfer |
| Outside the repository | Local clones, the Claude GitHub App installation and project settings, branch protection, webhooks, deploy keys | See the checklist |

## Checklist

Before the transfer:

1. Make sure no Deploy run or acquisition is in progress.
2. Remove the Azure trust so nothing in the subscription names the old owner:
   `./scripts/azure-github-trust.ps1 -ResourceGroup <group> -Remove` (`azure-pause.ps1` also does
   this).
3. Note the secrets and variables under Settings > Environments > `production`, so you can tell
   whether they arrived.
4. Check that you can create repositories in the target organization and that its Actions policy
   allows `actions/*`, `azure/login` and `docker/*`.

Transfer in Settings > General > Danger Zone > Transfer ownership.

After the transfer:

1. In every local clone: `git remote set-url origin https://github.com/<new-owner>/<name>.git`.
2. When you want to deploy again: `./scripts/azure-github-trust.ps1 -ResourceGroup <group>`. It
   prints the subject with the new owner ID before it writes it.
3. Check the `production` environment's secrets and variables; if any are missing, run
   `./scripts/azure-post-deploy.ps1 -ResourceGroup <group> -Step GitHub` (this also runs step 2).
4. Install the Claude GitHub App on the new owner and update the repository in any project or tool
   that points at it.
5. Replace `EGMamo/D365-FnO-MCP-Server` with the new path in `llms-install.md` and
   `docs/visual-studio-extension.md`.
6. Run the Deploy workflow once to prove the Azure sign-in works. If `azure/login` fails with
   AADSTS700213, the error text shows the subject GitHub sent; compare it with the one the script
   wrote.
