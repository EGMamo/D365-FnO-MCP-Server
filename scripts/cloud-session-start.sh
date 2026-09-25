#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (claude.ai/code, `claude --cloud`).
# Local sessions exit immediately. In the cloud it puts Node 24 on PATH (the VM image
# only ships Node 20-22) and installs and builds the project so `npm test` works.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

install_node24() {
  local dest="$1" base="https://nodejs.org/dist/latest-v24.x" tmp file
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' "$tmp/SHASUMS256.txt" | head -n 1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  mkdir -p "$dest"
  tar -xJf "$tmp/$file" -C "$dest" --strip-components=1
  rm -rf "$tmp"
}

# Prefer Node 24 preinstalled by the environment's setup script; otherwise install it
# per session (slower, not cached).
NODE_HOME=/opt/node24
if [ ! -x "$NODE_HOME/bin/node" ]; then
  NODE_HOME="$HOME/.local/node24"
  [ -x "$NODE_HOME/bin/node" ] || install_node24 "$NODE_HOME" >&2
fi

export PATH="$NODE_HOME/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_HOME/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Hook stdout is added to Claude's context, so send install/build noise to stderr.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci --no-audit --no-fund >&2
fi
npm run build >&2

echo "Cloud session ready: Node $(node --version) on PATH, dependencies installed, dist/ built (required by tests/mcpIntegration.test.ts)."
