#!/usr/bin/env bash
set -euo pipefail
export PATH="/go/bin:$PATH"
git config --global user.name Smoke
git config --global user.email smoke@example.invalid
mkdir -p /tmp/source /workspace
git -C /tmp/source init --initial-branch=main
printf 'base\n' >/tmp/source/file
git -C /tmp/source add .
git -C /tmp/source commit -m base
export PUSH_ARTIFACT_REMOTE=file:///tmp/source
push-artifactfs main file:///tmp/source
mountpoint /workspace
test "$(cat /workspace/file)" = base
printf 'changed\n' >/workspace/new
mv /workspace/new /workspace/file
git -C /workspace add file
git -C /workspace commit -m changed
git -C /workspace switch -c work
printf 'uncommitted\n' >/workspace/untracked
push-artifacts-checkpoint capture /workspace /tmp/checkpoint
push-artifacts-checkpoint restore /tmp/checkpoint /tmp/restored
test "$(cat /tmp/restored/file)" = changed
test "$(cat /tmp/restored/untracked)" = uncommitted
test "$(git -C /tmp/restored branch --show-current)" = work
git -C /tmp/restored fsck --full
push-artifactfs --cleanup
! mountpoint -q /workspace
mkdir -p /tmp/fail-git
cat >/tmp/fail-git/git <<'EOF'
#!/bin/sh
if [ "$*" = '-C /workspace remote rename origin push-artifacts' ]; then exit 1; fi
exec /usr/bin/git "$@"
EOF
chmod +x /tmp/fail-git/git
if PATH="/tmp/fail-git:$PATH" push-artifactfs main file:///tmp/source; then
  echo 'Expected injected remote setup failure' >&2
  exit 1
fi
! mountpoint -q /workspace
test ! -e /var/lib/push-artifactfs
echo 'ArtifactFS write/rename/commit/branch/checkpoint/cleanup smoke passed'
