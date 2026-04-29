#!/usr/bin/env bash
# Push sandbox snapshot — v1 prototype.
#
# Captures a workspace into <durable>/sessions/<key>/ with up to five
# artifacts:
#   head.sha          HEAD commit at snapshot time (sanity check on restore)
#   state.bundle      git bundle holding a stash-structured commit that
#                     encodes both staged and unstaged regions; absent if
#                     the working tree is clean against HEAD
#   stash.sha         the stash SHA inside state.bundle (for apply on restore)
#   untracked.tar.gz  untracked-but-not-ignored files; absent if none
#   deps.lockhash     pointer into <durable>/deps/<hash>.tar.gz; absent if
#                     no node_modules or no package-lock.json
#
# /durable is a stand-in for R2 — same layout, different backend.
#
# Source state preservation:
#   `git stash create` builds (but does not store) a commit whose tree is the
#   working tree and whose second parent's tree is the index. Bundling that
#   commit with --not HEAD packages exactly the objects unique to the dirty
#   state. On restore, `git stash apply --index` replays both regions.
#   Untracked files travel separately because stash create excludes them.

set -euo pipefail

WORKSPACE="${1:-}"
DURABLE="${2:-}"
SESSION_KEY="${3:-}"

if [ -z "$WORKSPACE" ] || [ -z "$DURABLE" ] || [ -z "$SESSION_KEY" ]; then
  echo "usage: snapshot.sh <workspace> <durable-root> <session-key>" >&2
  exit 2
fi

case "$SESSION_KEY" in
  /*|*..*|*$'\n'*|*$'\t'*|'')
    echo "invalid session key: $SESSION_KEY" >&2
    exit 2
    ;;
esac

[ -d "$WORKSPACE/.git" ] || { echo "not a git workspace: $WORKSPACE" >&2; exit 1; }

SESSION_DIR="$DURABLE/sessions/$SESSION_KEY"
DEPS_DIR="$DURABLE/deps"
mkdir -p "$SESSION_DIR" "$DEPS_DIR"

cd "$WORKSPACE"

HEAD_SHA=$(git rev-parse HEAD)
echo "$HEAD_SHA" > "$SESSION_DIR/head.sha"

STASH_SHA=$(git stash create 2>/dev/null || true)
if [ -n "$STASH_SHA" ]; then
  # Advertise under a refname so `git fetch` from the bundle on restore can
  # pull the ref through cleanly. The ref is local-only and removed below.
  # Write to .tmp first then mv so a crash mid-write can't leave a truncated
  # bundle that restore would treat as valid.
  STATE_BUNDLE_TMP="$SESSION_DIR/state.bundle.tmp"
  STASH_SHA_TMP="$SESSION_DIR/stash.sha.tmp"
  rm -f "$STATE_BUNDLE_TMP" "$STASH_SHA_TMP"
  git update-ref refs/push-snapshot/state "$STASH_SHA"
  git bundle create "$STATE_BUNDLE_TMP" \
    refs/push-snapshot/state --not "$HEAD_SHA" >/dev/null
  git update-ref -d refs/push-snapshot/state
  printf '%s\n' "$STASH_SHA" > "$STASH_SHA_TMP"
  mv "$STATE_BUNDLE_TMP" "$SESSION_DIR/state.bundle"
  mv "$STASH_SHA_TMP" "$SESSION_DIR/stash.sha"
else
  rm -f "$SESSION_DIR/state.bundle" "$SESSION_DIR/stash.sha"
fi

UNTRACKED_LIST=$(mktemp)
UNTRACKED_TAR_TMP=""
trap 'rm -f "$UNTRACKED_LIST" "${UNTRACKED_TAR_TMP:-}"' EXIT
git ls-files --others --exclude-standard -z > "$UNTRACKED_LIST"
if [ -s "$UNTRACKED_LIST" ]; then
  UNTRACKED_TAR_TMP=$(mktemp "$SESSION_DIR/untracked.tar.gz.tmp.XXXXXX")
  # --verbatim-files-from prevents tar from interpreting filenames starting
  # with `-` as options when read from -T (GNU tar 1.32+).
  tar --null --verbatim-files-from -T "$UNTRACKED_LIST" \
    -czf "$UNTRACKED_TAR_TMP"
  mv "$UNTRACKED_TAR_TMP" "$SESSION_DIR/untracked.tar.gz"
  UNTRACKED_TAR_TMP=""
else
  rm -f "$SESSION_DIR/untracked.tar.gz"
fi

if [ -f package-lock.json ] && [ -d node_modules ]; then
  LOCK_HASH=$(sha256sum package-lock.json | awk '{print $1}')
  DEPS_TAR="$DEPS_DIR/$LOCK_HASH.tar.gz"
  if [ ! -f "$DEPS_TAR" ]; then
    tar -czf "$DEPS_TAR.tmp" node_modules
    mv "$DEPS_TAR.tmp" "$DEPS_TAR"
  fi
  echo "$LOCK_HASH" > "$SESSION_DIR/deps.lockhash"
else
  rm -f "$SESSION_DIR/deps.lockhash"
fi

echo "snapshot ok: $SESSION_DIR"
