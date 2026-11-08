# d365-fno-mcp-client

The developer package of the [D365 FnO MCP server](https://github.com/EGMamo/D365-FnO-MCP-Server). It gives your AI
agent a local gateway grounded in your custom Dynamics 365 Finance and Operations models.

```bash
npx d365-fno-mcp-client setup
```

Setup asks one question:

1. **Local only.** Only your custom models are indexed, on this machine, by the gateway itself. There is no hosted
   server, no URL and no key. Standard Microsoft objects are not known in this mode.
2. **Hosted.** A hosted server answers for the standard application, and your custom models are still indexed here
   (their code never leaves this machine). You need the server's URL and a developer key from your operator.
   Deploying a new hosted server needs the operator package, `d365-fno-mcp-server`.

Then start the gateway and register the client entry it prints:

```bash
npx d365-fno-mcp gateway
```

Commands: `setup`, `gateway`, `doctor`, `help`, `version`. Developer keys are issued by your operator; this package
cannot create them.
