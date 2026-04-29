#!/usr/bin/env bash
# Round-trip smoke test for snapshot/restore.
#
# Builds a workspace with one file in each git region (committed, staged,
# unstaged, untracked), snapshots it, recreates the clone elsewhere, restores,
# and diffs `git status --porcelain=v1` between original and restored.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ORIGIN="$SCRATCH/origin.git"
WORK_A="$SCRATCH/work-a"
WORK_B="$SCRATCH/work-b"
DURABLE="$SCRATCH/durable"
SESSION_KEY="acme/repo/main/sess-001"

git init --quiet --bare "$ORIGIN"

# Build a workspace with content in each region.
git clone --quiet "$ORIGIN" "$WORK_A"
cd "$WORK_A"
git config user.email "test@push.local"
git config user.name "test"
git config commit.gpgsign false  # synthetic fixture; not a real commit

echo "alpha v1" > committed.txt
echo "beta v1"  > staged.txt
echo "gamma v1" > unstaged.txt
git add . && git commit --quiet -m "init"
git push --quiet origin HEAD:refs/heads/main

echo "beta v2"          > staged.txt
git add staged.txt
echo "gamma v2"         > unstaged.txt
echo "delta untracked"  > untracked.txt

ORIG_STATUS=$(git status --porcelain=v1 | sort)
ORIG_STAGED=$(git diff --cached)
ORIG_UNSTAGED=$(git diff)
ORIG_UNTRACKED_CONTENT=$(cat untracked.txt)

"$HERE/snapshot.sh" "$WORK_A" "$DURABLE" "$SESSION_KEY"

# Fresh clone, then restore.
git clone --quiet --branch main "$ORIGIN" "$WORK_B"
cd "$WORK_B"
git config user.email "test@push.local"
git config user.name "test"
git config commit.gpgsign false  # synthetic fixture; not a real commit

"$HERE/restore.sh" "$WORK_B" "$DURABLE" "$SESSION_KEY"

NEW_STATUS=$(git status --porcelain=v1 | sort)
NEW_STAGED=$(git diff --cached)
NEW_UNSTAGED=$(git diff)
NEW_UNTRACKED_CONTENT=$(cat untracked.txt)

fail=0
if [ "$ORIG_STATUS" != "$NEW_STATUS" ]; then
  echo "FAIL: porcelain status differs"
  diff <(printf '%s\n' "$ORIG_STATUS") <(printf '%s\n' "$NEW_STATUS") || true
  fail=1
fi
if [ "$ORIG_STAGED" != "$NEW_STAGED" ]; then
  echo "FAIL: staged diff differs"; fail=1
fi
if [ "$ORIG_UNSTAGED" != "$NEW_UNSTAGED" ]; then
  echo "FAIL: unstaged diff differs"; fail=1
fi
if [ "$ORIG_UNTRACKED_CONTENT" != "$NEW_UNTRACKED_CONTENT" ]; then
  echo "FAIL: untracked content differs"; fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "OK — staged/unstaged/untracked all preserved"
  echo "status:"
  printf '%s\n' "$NEW_STATUS" | sed 's/^/  /'
fi
exit "$fail"
