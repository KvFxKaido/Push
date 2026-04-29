#!/usr/bin/env bash
# Push sandbox restore — v1 prototype.
#
# Caller is responsible for cloning the repo at HEAD into <workspace> first.
# This script overlays the snapshot artifacts onto that clean clone.
#
# Restore order (cheapest first):
#   1. image cache  — `cp -al $PUSH_IMAGE_CACHE/node_modules` if lockfile matches
#   2. deps cache   — `tar -xz $DURABLE/deps/<lockHash>.tar.gz` if hash present
#   3. (deps miss is reported; caller runs `npm ci` — out of scope here)
#   4. staged + unstaged via git stash bundle
#   5. untracked overlay
#
# Assumes a fresh clone: `git stash apply --index` may fail if the working
# tree already has unrelated changes.

set -euo pipefail

WORKSPACE="${1:-}"
DURABLE="${2:-}"
SESSION_KEY="${3:-}"
IMAGE_CACHE="${PUSH_IMAGE_CACHE:-/opt/push-cache}"

if [ -z "$WORKSPACE" ] || [ -z "$DURABLE" ] || [ -z "$SESSION_KEY" ]; then
  echo "usage: restore.sh <workspace> <durable-root> <session-key>" >&2
  exit 2
fi

[ -d "$WORKSPACE/.git" ] || { echo "not a git workspace: $WORKSPACE" >&2; exit 1; }

SESSION_DIR="$DURABLE/sessions/$SESSION_KEY"
DEPS_DIR="$DURABLE/deps"

cd "$WORKSPACE"

if [ -f "$SESSION_DIR/head.sha" ]; then
  WANT=$(cat "$SESSION_DIR/head.sha")
  HAVE=$(git rev-parse HEAD)
  if [ "$WANT" != "$HAVE" ]; then
    echo "warn: HEAD mismatch (snapshot=$WANT current=$HAVE)" >&2
  fi
fi

if [ ! -d node_modules ] && [ -f package-lock.json ]; then
  LOCK_HASH=$(sha256sum package-lock.json | awk '{print $1}')
  RESTORED=""
  if [ -f "$IMAGE_CACHE/package-lock.json" ] \
     && cmp -s package-lock.json "$IMAGE_CACHE/package-lock.json" \
     && [ -d "$IMAGE_CACHE/node_modules" ]; then
    cp -al "$IMAGE_CACHE/node_modules" node_modules
    RESTORED="image-cache"
  elif [ -f "$DEPS_DIR/$LOCK_HASH.tar.gz" ]; then
    tar -xzf "$DEPS_DIR/$LOCK_HASH.tar.gz"
    RESTORED="deps-cache"
  fi
  if [ -n "$RESTORED" ]; then
    echo "deps restored from $RESTORED ($LOCK_HASH)"
  else
    echo "deps cache miss — caller should run 'npm ci'"
  fi
fi

if [ -f "$SESSION_DIR/state.bundle" ] && [ -f "$SESSION_DIR/stash.sha" ]; then
  git fetch --quiet "$SESSION_DIR/state.bundle" \
    'refs/push-snapshot/state:refs/push-snapshot/state'
  STASH_SHA=$(cat "$SESSION_DIR/stash.sha")
  git stash apply --index "$STASH_SHA"
  git update-ref -d refs/push-snapshot/state
  echo "applied staged+unstaged from $STASH_SHA"
fi

if [ -f "$SESSION_DIR/untracked.tar.gz" ]; then
  tar -xzf "$SESSION_DIR/untracked.tar.gz"
  echo "applied untracked overlay"
fi

echo "restore ok: $WORKSPACE"
