#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The repo requires Node >=24 (`engines` in package.json; CI pins 24), but the
# cloud sandbox image ships Node 22. On 22, `pnpm run test:cli` does not fail
# cleanly: `silvery` uses `using` declarations Node 22 cannot parse, and the
# suite hangs. This hook puts Node 24 first on PATH for the session, then
# installs workspace dependencies.
#
# Integrity: the tarball is checked against SHASUMS256.txt fetched from the
# same nodejs.org origin over HTTPS. That catches corrupt or truncated
# downloads; it is not a provenance check (no SHASUMS256.txt.sig verification),
# so it trusts nodejs.org itself.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_MAJOR=24
NODE_CACHE="${HOME}/.cache/push-node"

current_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  # Only fully extracted installs are ever renamed into place (below), so any
  # node-v<major>.* directory here is complete.
  node_dir=$(ls -d "$NODE_CACHE"/node-v"$NODE_MAJOR".*-linux-*/ 2>/dev/null | sort -V | tail -1 || true)
  if [ -z "$node_dir" ]; then
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) echo "session-start: unsupported arch $(uname -m)" >&2; exit 1 ;;
    esac
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    mkdir -p "$NODE_CACHE"
    rm -rf "$NODE_CACHE"/.staging.* # leftovers from an interrupted run
    # Stage inside the cache dir so the final rename stays on one filesystem
    # and is atomic; an interrupted extraction never becomes a visible install.
    staging=$(mktemp -d "$NODE_CACHE/.staging.XXXXXX")
    trap 'rm -rf "$staging"' EXIT
    curl -fsSL "$base/SHASUMS256.txt" -o "$staging/SHASUMS256.txt"
    tarball=$(grep -oE "node-v${NODE_MAJOR}\.[0-9.]+-linux-${arch}\.tar\.xz" "$staging/SHASUMS256.txt" | head -1)
    curl -fsSL "$base/$tarball" -o "$staging/$tarball"
    (cd "$staging" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
    tar -xJf "$staging/$tarball" -C "$staging"
    node_dir="$NODE_CACHE/${tarball%.tar.xz}"
    if [ ! -d "$node_dir" ]; then
      mv "$staging/${tarball%.tar.xz}" "$node_dir"
    fi
  fi
  node_bin="${node_dir%/}/bin"
  export PATH="$node_bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  else
    echo "session-start: CLAUDE_ENV_FILE unset; Node $NODE_MAJOR is on PATH for this hook only" >&2
  fi
fi

cd "$CLAUDE_PROJECT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  # Node 25+ no longer bundles corepack; fall back to the pinned version.
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm
  else
    npm install -g "$(node -p 'require("./package.json").packageManager')"
  fi
fi

# Frozen: lockfile drift should fail loudly, not leave a rewritten
# pnpm-lock.yaml in the worktree at the start of every session.
pnpm install --frozen-lockfile
