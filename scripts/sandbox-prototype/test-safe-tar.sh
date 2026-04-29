#!/usr/bin/env bash
# Negative tests for restore.sh's tar-traversal guard.
#
# Builds tampered archives whose entries escape the workspace (`../escape`,
# absolute paths) and verifies restore.sh refuses to extract them and that
# nothing lands at the escape target. A benign control case confirms the
# guard isn't over-rejecting.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ORIGIN="$SCRATCH/origin.git"
WORK="$SCRATCH/work"
DURABLE="$SCRATCH/durable"
SESSION_KEY="acme/repo/main/sess-evil"
SESSION_DIR="$DURABLE/sessions/$SESSION_KEY"

git init --quiet --bare "$ORIGIN"
git clone --quiet "$ORIGIN" "$WORK"
cd "$WORK"
git config user.email "test@push.local"
git config user.name "test"
git config commit.gpgsign false  # synthetic fixture; not a real commit
echo "init" > a.txt
git add . && git commit --quiet -m init
git push --quiet origin HEAD:refs/heads/main

mkdir -p "$SESSION_DIR"
git rev-parse HEAD > "$SESSION_DIR/head.sha"

# Build a tar containing a single entry with the supplied (potentially
# unsafe) path. -P preserves the leading slash for the absolute-path case.
make_tar_with_entry() {
  local out="$1" entry_name="$2"
  local payload="$SCRATCH/payload-$$"
  rm -rf "$payload" && mkdir -p "$payload"
  echo "pwned" > "$payload/x"
  tar -czPf "$out" -C "$payload" \
    --transform "s|^x\$|${entry_name}|" x
}

fail=0

run_unsafe() {
  local label="$1" entry_name="$2" escape_target="$3"
  echo "--- $label: $entry_name ---"
  make_tar_with_entry "$SESSION_DIR/untracked.tar.gz" "$entry_name"
  rm -f "$escape_target"
  if "$HERE/restore.sh" "$WORK" "$DURABLE" "$SESSION_KEY" >/dev/null 2>&1; then
    echo "  FAIL: restore.sh accepted unsafe archive"
    fail=1
  elif [ -e "$escape_target" ]; then
    echo "  FAIL: escape target was written: $escape_target"
    rm -f "$escape_target"
    fail=1
  else
    echo "  refused as expected"
  fi
  rm -f "$SESSION_DIR/untracked.tar.gz"
}

run_unsafe "parent traversal" "../escape.txt" "$SCRATCH/escape.txt"
run_unsafe "absolute path"    "$SCRATCH/abspwn.txt" "$SCRATCH/abspwn.txt"

echo "--- benign control: harmless.txt ---"
make_tar_with_entry "$SESSION_DIR/untracked.tar.gz" "harmless.txt"
rm -f "$WORK/harmless.txt"
if ! "$HERE/restore.sh" "$WORK" "$DURABLE" "$SESSION_KEY" >/dev/null 2>&1; then
  echo "  FAIL: restore.sh rejected benign archive"
  fail=1
elif [ ! -f "$WORK/harmless.txt" ]; then
  echo "  FAIL: benign file not extracted"
  fail=1
else
  echo "  extracted as expected"
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "OK — safe_tar refuses ../ and /abs entries, allows benign ones"
fi
exit "$fail"
