/** Help of the developer package (`d365-fno-mcp`): the five commands it has, nothing of the operator package. */
export const CLIENT_HELP_TEXT = `d365-fno-mcp <command> [options]

Commands:
  setup [--non-interactive] Create a .env configuration file. It asks how you will use it:
                            local only (your custom models, no hosted server), or a hosted server plus your
                            custom models. Deploying a hosted server needs the operator package.
      --mode <local|hosted> local: index only your custom models here. hosted: use a hosted server too
      --custom-dir <dir>    Folder with your custom models (both modes)
      --index-path <path>   Where to keep the local index (local; default ./.d365/custom_index.db)
      --hosted-url <url>    Hosted MCP endpoint, https:// unless loopback (hosted)
      --hosted-api-key-file <file>  File holding your developer key (hosted; preferred)
      --hosted-api-key <key>        Your developer key (hosted; visible in the process list, so prefer the file)
      --force               Replace an existing .env
  gateway                   Start the local gateway on 127.0.0.1: your custom models are indexed here, and
                            merged with the hosted server's standard index when D365_HOSTED_MCP_URL is set
  doctor                    Check the gateway settings and the hosted server (exit 1 on failure)
  help                      Show this help
  version                   Show the version

Options:
  -h, --help                Show help
  -v, --version             Show version

Flags accept --flag, --flag=value, and --flag value forms.
`;
