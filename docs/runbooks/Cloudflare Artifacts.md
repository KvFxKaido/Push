# Cloudflare Artifacts

Status: Draft (implemented locally; Cloudflare staging validation pending)

## Configuration

`CF_ARTIFACTS` is the Cloudflare Git storage binding. It uses `push` in
production and `push-staging` in the standalone staging config. Create those
namespaces in the intended account before deployment. Wrangler 4.145.0 or
newer is required; validation used 4.155.0. Both switches are off in production
and on in staging:

- `PUSH_ARTIFACT_CHECKPOINTS=1`: capture workspace snapshots in Artifacts.
- `PUSH_ARTIFACT_FS=1`: use ArtifactFS for eligible fresh checkouts. Requires
  checkpoint support, snapshot indexing, and the sandbox token KV store.

Worker Previews still use Modal and do not bind this store. Despite the name,
this is unrelated to Push's renderable artifacts (`create_artifact`, the
`ARTIFACTS` KV binding, `~/.push/artifacts`), which are unchanged.

## Checkpoints

Each snapshot gets a dedicated repository with an expiry-bearing name. A
parentless transport commit contains `workspace/` and chunked Git metadata.
It does not modify the live HEAD or index. This preserves shallow boundaries,
unpushed commits, staged changes, working-tree changes, symlinks, and file modes.
Ignored untracked files are excluded. Checkpoint file inspection can use the
Artifacts binding's `readFile` with `workspace/<path>`; no new user-facing
history/fork UI is introduced by this transport change.
Transport Git attributes are neutralized during capture and before checkout
on restore, preserving line endings, ident strings, and encoded bytes without
running clean/smudge filters. Empty working trees restore with their Git metadata.

The R2 descriptor and restore-token authorization remain the entry point.
Restore pins the saved transport commit and reconstructs Git metadata in an
empty staging directory before the existing workspace-materialization path.
Short-lived write/read tokens are revoked after transfer. Authenticated URLs
are not returned to callers or logged. Promisor objects are hydrated before
capture only for partial/promisor repositories, and the Cloudflare remote is
removed from the saved Git config.

Cloudflare currently limits a push to 64 MiB, files to 32 MiB, and repositories
to 1 GB. A rejected capture/upload falls back to DirectoryBackup for ordinary
workspaces. Submodules and external Git alternates also use that fallback.
Mounted workspaces fail the checkpoint explicitly instead of returning a backup
with an external, unrestorable Git directory. The sandbox must remain alive
when snapshot capture fails.

## ArtifactFS

The image builds `cloudflare/artifact-fs` at
`2b87a48691ef4ae82d391b7bbe4976c06c7fadf7` with a digest-pinned Go 1.26 image
and installs fuse3. Failed mount setup cleans up its daemon and mount before
returning; an unmount failure preserves runtime state for a cleanup retry.
Public GitHub branches import into a read-only Artifacts source repository,
then mount at `/workspace`. GitHub credentials are stripped before import.
Private imports fail back to the existing authenticated shallow clone.
Workspaces with an existing snapshot use ordinary clones so recovery never
wipes a live FUSE mount. GitHub remains the user push target; a separate
Cloudflare promisor remote serves lazy blobs. Automatic upstream refresh is off.

After import finishes, a read token with the service's one-year maximum TTL
lives only in the sandbox; the initial token is revoked. Source deletion
revokes access earlier. This token can read only the imported public tree.
Each sandbox operation renews a two-day KV lease at most once per five minutes.
Destroy deletes the source repository and lease; daily cleanup deletes expired
unleased source repositories and expired checkpoints, including failed uploads.
Repository names carry expiry independently of the expiring snapshot index.

The baked dependency cache uses hardlinks on the ordinary filesystem and copies
on FUSE. This avoids cross-filesystem hardlink failures but can cost more time;
no startup-speed improvement is claimed without staging timing measurements.

## Validation and rollout

Local integration checks:

```sh
python3 scripts/test-artifacts-checkpoint.py
docker build --target artifactfs -f Dockerfile.sandbox -t push-artifactfs-test .
docker build -f scripts/artifactfs-smoke.Dockerfile -t push-artifactfs-smoke .
docker run --rm --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined push-artifactfs-smoke
pnpm --filter my-app exec vitest run src/worker/cloudflare-artifacts.test.ts src/worker/sandbox-do.test.ts src/worker/worker-cf-sandbox.test.ts
pnpm run typecheck:all
```

Before enabling production: deploy to the standalone staging Worker; exercise
public mounted and private ordinary checkouts; checkpoint/hibernate/restore with
an unpushed commit and staged changes; test rejected large uploads; verify
source leases and deletion; compare `cf_sandbox_create_timing` phases. Then
enable the switches independently. Disabling them stops new mounts/captures;
keep the binding and cleanup cron while existing Artifacts checkpoints expire.

References: [binding API](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[limits](https://developers.cloudflare.com/artifacts/platform/limits/),
[ArtifactFS](https://github.com/cloudflare/artifact-fs).

## Local verification (2026-10-28)

- App: 441 test files, 7,617 passing tests, 4 todo (after restoring the
  renderable-artifact feature, which this change originally removed).
- MCP: 74 passing tests. Typechecks, ESLint, and formatting pass.
- Real shallow-Git round trip and Docker FUSE smoke pass, including an actual
  writable mount, rename, commit, branch switch, capture/restore, unmount, and
  injected post-mount failure cleanup. Four clone-based checkpoint tests cover
  shallow history/index preservation, attributes, filters, and empty worktrees.
- Staging config types generated with Wrangler 4.155.0. Full container-build
  dry run and final Worker-only dry run pass. No Worker was deployed.
- CLI artifact, tool-card drift, daemon-integration, adoption-loop, and
  tool-policy suites: 325 passing on Windows.

Remote namespace provisioning, Git push/clone against the Artifacts service,
and staging lifecycle acceptance remain unverified. Production switches stay off.
