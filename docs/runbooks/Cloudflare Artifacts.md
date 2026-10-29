# Cloudflare Artifacts

Status: Draft (staging-validated 2026-10-28: checkpoints pass; ArtifactFS fails on real repos, keep it off)

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

## Staging acceptance (2026-10-28)

Deployed to `push-staging` and driven through `/api/sandbox-cf/*` (create, exec,
hibernate, restore-snapshot, delete-snapshot, cleanup).

The first staging run found three defects that local checks could not:

1. The binding returns account-scoped remotes
   (`<account id>.artifacts.cloudflare.net`), and the remote guard accepted only
   the bare host, so every mount and checkpoint threw and silently fell back.
   The guard now accepts both, and the fixtures use the real shape.
2. ArtifactFS strips inline credentials and hydrates blobs with ambient Git
   credentials. With none configured, any Git command that needed a missing
   blob failed (`could not fetch … from promisor remote`). The mount helper now
   writes the read token to a store-helper file outside the workspace and its
   gitdir.
3. Renaming the imported `origin` left no `refs/remotes/origin/<branch>`, so
   upstream tracking and diff bases were missing. The helper now creates it.

Both fallback logs now carry a credential-stripped `reason`, and the success paths
log `cf_artifactfs_mounted` / `cf_artifact_checkpoint_captured`.

Results after the fixes:

| Check | Result |
| --- | --- |
| Ordinary git workspace → Artifacts checkpoint → restore (unpushed commit, staged, CRLF unstaged) | Pass: HEAD, history, index, and bytes identical; hibernate ~4 s, restore ~7 s |
| Public repo mount → lazy read, commit, diff against history, upstream `[ahead 1]` → checkpoint → restore | Pass on `octocat/Hello-World`; restored workspace is plain and has no Artifacts remote |
| 70 MiB workspace | Pass: falls back to DirectoryBackup (logged with reason); file survives |
| Import failure (missing branch) | Pass: no stale mount; reason `Branch not found` |
| Repository cleanup | Pass: namespace empty after destroy and delete-snapshot |
| Large repo (`facebook/react`) mount | **Fail**: create 13.7 s vs 5.7 s for a plain `git clone --depth 1` (72 MB); first `git status` on the mount did not finish within the 150 s exec deadline (twice); a grep over `packages/react/src` took 31 s |

Conclusion: checkpoints are ready to enable after review. ArtifactFS at this pin
is slower than a shallow clone and makes basic Git unusable on a real repository,
which matches the archived evaluation's concerns; keep `PUSH_ARTIFACT_FS` off.
Private-repository checkouts were not tested: staging has no GitHub credentials.
