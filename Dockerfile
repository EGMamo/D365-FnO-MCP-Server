# syntax=docker/dockerfile:1
#
# Hosted (read-only) D365 FnO MCP server.
#
# The image carries no index. At start-up `serve` downloads the published
# index named by D365_INDEX_URL into D365_INDEX_DB_PATH (container-local disk,
# not /home, which App Service mounts as a network share where SQLite cannot
# lock), then listens on MCP_PORT. Write tools stay disabled.

# Builds behind a private registry or a TLS-inspecting proxy can pass an .npmrc
# (registry, auth token, cafile) as a BuildKit secret without baking it in:
#   docker build --secret id=npmrc,src=$HOME/.npmrc .
# The mount is empty and harmless when no secret is given.

FROM node:24-slim AS build
# The base image's npm would otherwise print an upgrade notice on every install.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
# The optional mssql driver is only needed by index-xref, which never runs here.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=secret,id=cafile,target=/etc/npm-cafile.crt \
    npm ci --omit=optional
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    MCP_TRANSPORT=http \
    MCP_PORT=8080 \
    D365_INDEX_DB_PATH=/data/d365_index.db \
    D365_ENABLE_WRITE_TOOLS=0 \
    D365_INDEX_ON_START=0
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=secret,id=cafile,target=/etc/npm-cafile.crt \
    npm ci --omit=dev --omit=optional && rm -rf /root/.npm
COPY --from=build /app/dist ./dist
# findKnowledgeDir() walks up from dist/src/tools, so the knowledge base must sit next to dist/.
COPY d365-fno-assistant-knowledge ./d365-fno-assistant-knowledge
COPY README.md LICENSE ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
# start-period covers the index download, which happens before the server listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=900s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.MCP_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "dist/src/index.js"]
CMD ["serve"]
