// Example nonproduction parameters. Copy per environment; keep identifiers
// here, never secret values.
using 'main.bicep'

param environmentName = 'dev'
param location = 'westeurope'
// Lowest-cost settings for dev; see costProfile in main.bicep.
param costProfile = 'cheapest'
param tags = {
  owner: 'd365-mcp'
}

// Restrict to known client ranges once they are stable; empty allows all (API keys still apply).
param allowedIngressCidrs = []

param alertEmailReceivers = []

// Read from the deploying shell or pipeline secret store at deployment time.
param workerAdminPassword = readEnvironmentVariable('D365_WORKER_ADMIN_PASSWORD')
