#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The repo requires Node >=24 (`engines` in package.json; CI pins 24), but the
# cloud sandbox image ships Node 22. On 22, `pnpm run test:cli` does not fail
# cleanly: `silvery` uses `using` declarations Node 22 cannot parse, and the
# suite hangs. This hook puts a checksum-verified Node 24 first on PATH for the
# session, then installs workspace dependencies.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_MAJOR=24
NODE_CACHE="${HOME}/.cache/push-node"

current_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  node_dir=$(ls -d "$NODE_CACHE"/node-v"$NODE_MAJOR".*-linux-*/ 2>/dev/null | sort -V | tail -1 || true)
  if [ -z "$node_dir" ] || [ ! -x "${node_dir%/}/bin/node" ]; then
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) echo "session-start: unsupported arch $(uname -m)" >&2; exit 1 ;;
    esac
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    tarball=$(grep -oE "node-v${NODE_MAJOR}\.[0-9.]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
    curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
    (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
    mkdir -p "$NODE_CACHE"
    tar -xJf "$tmp/$tarball" -C "$NODE_CACHE"
    node_dir="$NODE_CACHE/${tarball%.tar.xz}"
  fi
  node_bin="${node_dir%/}/bin"
  export PATH="$node_bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  else
    echo "session-start: CLAUDE_ENV_FILE unset; Node $NODE_MAJOR is on PATH for this hook only" >&2
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm
fi

cd "$CLAUDE_PROJECT_DIR"
pnpm install
