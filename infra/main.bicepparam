// Example parameters. Secrets come from the environment so this file can be
// committed:
//   export SQL_ADMIN_PASSWORD='...' MCP_API_KEYS='alice=...,ci=...'
//   az deployment group create -g rg-d365-mcp -f infra/main.bicep -p infra/main.bicepparam
using './main.bicep'

param namePrefix = 'd365mcp'
param appServiceSku = 'P0v3'
param imageTag = 'latest'
param sqlAdminLogin = 'xrefadmin'
param sqlAdminPassword = readEnvironmentVariable('SQL_ADMIN_PASSWORD')
param mcpApiKeys = readEnvironmentVariable('MCP_API_KEYS')
param indexSasUrl = readEnvironmentVariable('INDEX_SAS_URL', '')
param indexUploadKeys = readEnvironmentVariable('INDEX_UPLOAD_KEYS', '')
param indexPublishSasUrl = readEnvironmentVariable('INDEX_PUBLISH_SAS_URL', '')
param devMachineIp = readEnvironmentVariable('DEV_MACHINE_IP', '')
param publisherPrincipalId = readEnvironmentVariable('PUBLISHER_PRINCIPAL_ID', '')
param deployerPrincipalId = readEnvironmentVariable('DEPLOYER_PRINCIPAL_ID', '')
