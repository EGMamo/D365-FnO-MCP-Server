# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue. Use GitHub's
**Report a vulnerability** button on the repository's **Security** tab (private
vulnerability reporting). If that button is not available, open an issue that
asks for a private contact without describing the problem.

Include what you found, how to reproduce it, and which version or commit you
tested. You should get an acknowledgement within a week.

## Supported versions

Only the latest commit on `master` (and the newest release tag, once there is
one) receives security fixes.

## Security model in short

- **HTTP transport**: every route except `GET /health` needs one of the keys in
  `MCP_API_KEYS` (or `MCP_API_KEY`), sent as `X-API-Key` or
  `Authorization: Bearer`. Keys are at least 32 characters and compared in
  constant time; only key names are logged. An MCP session only accepts the key
  that opened it.
- **Index uploads** (`/admin/index/uploads`) additionally need a key named in
  `D365_INDEX_UPLOAD_KEYS`. Uploads are checked per chunk, on the whole package
  and on the decoded database, and decoding stops at the declared size.
- **Write tools** are off unless `D365_ENABLE_WRITE_TOOLS=1`, only write inside
  `D365_CUSTOM_METADATA_DIR`, and are always off in hosted mode.
- **Secrets**: SQL connection strings and SAS URLs are read from the
  environment and never logged with their query strings.
- **HTTP transport** requires a configured API key on every MCP request.

## Operating a server safely

- Generate each key with `openssl rand -hex 32`, give each person or client its
  own named key, and remove a name from `MCP_API_KEYS` to revoke it.
- Bind a local server to `127.0.0.1` (`MCP_HOST`) and put a shared one behind
  TLS. Raise `TRUST_PROXY_HOPS` only for proxies you control.
- Give the XRef and Trace Parser importers a read-only SQL login.
- Scope the publish SAS (`D365_INDEX_PUBLISH_URL`) to one container with create
  and write rights, and the read SAS in `D365_INDEX_URL` to read only.

See also the [Responsible AI and security FAQ](docs/responsible-ai-faq.md).
