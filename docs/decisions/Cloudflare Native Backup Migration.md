# Cloudflare Native Backup Migration

Date: 2026-05-25
Status: **Draft** — design-in-motion; needs a `ROADMAP.md` entry to graduate to an implementation commitment
Owner: Push
Related: `docs/decisions/Cloudflare Sandbox Provider Design.md` (the provider this swaps the snapshot impl inside),
`docs/decisions/Modal Sandbox Snapshots Design.md` (the snapshot index / TTL model the routes mirror),
`app/src/worker/worker-cf-sandbox.ts` (`createWorkspaceSnapshot` / `restoreWorkspaceSnapshot` — the two functions this replaces),
`app/src/worker/snapshot-index.ts`, `app/src/worker/coder-job-do.ts` (DO resume loop — unchanged),
`scripts/snapshot-smoke/` (route-level regression harness for the swap)

## TL;DR

Push hand-rolled R2-backed filesystem snapshots for the Cloudflare sandbox
backend (#647–#651): `tar -czf /workspace` → base64 → `R2.put`; restore is
`R2.get` → base64 → hydrate into a fresh sandbox. The `@cloudflare/sandbox` SDK
has shipped a **native `createBackup`/`restoreBackup` API since 2026-02-23** —
available before our custom path shipped — that does the same job with a better
architecture. We did not adopt it. This doc records the decision to migrate the
CF snapshot *implementation* to the native API **behind the existing
`SandboxProvider` abstraction**, plus the surface of that change and its risks.

## Why revisit

The custom path's load-bearing weakness is the **32 MB compressed ceiling**
(`MAX_SNAPSHOT_BYTES`): the archive is base64-encoded and passes through Worker
memory twice — once on hibernate (from `exec` stdout) and once on restore
(`object.text()` + the `writeFile` arg) — against a ~128 MB Worker memory
budget. node_modules is excluded and clones are shallow, so source-only
snapshots usually fit, but it is a hard ceiling we own and an architectural smell
we would otherwise carry forever.

## What the native API actually does (verified 2026-05-25, SDK 0.8.11)

| Aspect | Native SDK | Our custom path |
|---|---|---|
| Methods | `createBackup(opts) → DirectoryBackup {id, dir}`; `restoreBackup({id, dir}) → {success, dir, id}` | `createWorkspaceSnapshot` / `restoreWorkspaceSnapshot` |
| Archive | **squashfs**, uploaded by **presigned URL + multipart** (no Worker-memory round-trip) | `tar.gz` → base64 through Worker memory (32 MB cap) |
| Restore | **FUSE overlayfs mount** (RO lower + writable CoW upper) in prod; dir *replaced* in local dev (`localBucket: true`) | extract base64 → `tar -xzf` into fresh sandbox |
| Storage | **your** R2 via `BACKUP_BUCKET` binding; `backups/{id}/data.sqsh` + `meta.json` | your R2 via `SNAPSHOTS` binding; `cf-snapshots/<uuid>` |
| Handle | `DirectoryBackup {id, dir}` — serializable, docs say store in KV/D1/DO | `snapshot_id` + `restore_token` (R2 customMetadata) |
| Excludes | `excludes` globs + `gitignore` (keeps `.git` by default) | hardcoded `SNAPSHOT_DIR_EXCLUDES` |
| TTL | `ttl` (default 3 days, no upper bound), enforced **at restore time only**; does **not** auto-delete from R2 | KV index TTL (7 days) + inline reclaim + cron reaper |
| Size ceiling | none documented (the ~24 MiB issue was the local-dev RPC transport, since fixed) | 32 MB compressed |
| Maturity | Sandbox SDK is **Beta**; the backup API is not separately flagged experimental | ours, stable |

Key correction to the 2026-04-19 spike (`scripts/cf-sandbox-spike/`, now retired):
it guessed "the SDK manages its own backup storage." It does **not** — backups
land in *your own* `BACKUP_BUCKET`. Production also needs presigned-URL creds
(`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_ACCOUNT_ID`,
`BACKUP_BUCKET_NAME`) — **secrets**; on this public repo they go in the secret
store / `.dev.vars`, never committed.

## Decision

**Lean: migrate**, as a deliberate, contained swap — not a rip-out, not urgent.

- Native eliminates our worst smell (the 32 MB Worker-memory ceiling) by
  streaming container↔R2, and restores by *mounting* rather than extracting —
  architecturally faster and not memory-bound. These are structural wins, not
  line-count wins.
- The Push-specific glue (repo/branch → handle index, retention lifecycle, DO
  resume loop, route-layer auth, Modal wire-contract parity) stays either way,
  so this is swapping two function bodies behind the abstraction we already
  built — bounded and reversible.
- The real cost is taking a **Beta** dependency on the load-bearing resume path.
  We are a **single-user** deployment: blast radius is one user and rollback is a
  revert, so we can tolerate a Beta dependency a multi-tenant product could not.
  That tolerance is what tips this to "migrate."

The one reason to *not* bother: if we would rather avoid a Beta dependency on
resume entirely. The custom path works today; the only concrete thing we give up
by keeping it is the 32 MB headroom.

## Migration surface (the contained swap)

1. **Config.** Add `BACKUP_BUCKET` R2 binding (can point at the existing
   `push-cf-snapshots` bucket) + presigned creds as secrets. Keep `SNAPSHOTS`
   bound during a transition window so old snapshots stay restorable.
2. **Swap two function bodies** in `worker-cf-sandbox.ts`:
   - `createWorkspaceSnapshot` → `sandbox.createBackup({ dir: '/workspace', ttl, excludes: [...SNAPSHOT_DIR_EXCLUDES], gitignore: false })`, return the `DirectoryBackup`.
   - `restoreWorkspaceSnapshot` → `getSandbox(...).restoreBackup({ id, dir: '/workspace' })` on a fresh sandbox, then mint the owner token + probe (unchanged).
3. **Index shape** (`snapshot-index.ts`): store the serialized `DirectoryBackup`
   (`id` + `dir`) as the handle; **drop `restoreToken`** (native has no per-object
   token — see security note). Bump `INDEX_SCHEMA_VERSION`.
4. **Retention.** Keep the R2 lifecycle rule (`r2:snapshots:lifecycle`) — native
   TTL does **not** auto-delete. Drop the manual base64 reclaim path; the cron
   reaper can stay as an orphan backstop, retargeted at the `backups/` prefix.
5. **Routes / wire contract — unchanged.** `/api/sandbox-cf/hibernate`,
   `restore-snapshot`, `delete-snapshot` keep their request/response shapes
   (Modal parity), so the client (idle-hibernate + reconnect-restore) and the DO
   resume loop need no changes beyond the security-model note below.
6. **Smoke-test deltas** (`scripts/snapshot-smoke/`): Layer 1 (round-trip
   integrity + latency) is route-level and validates the swap **unchanged** —
   it is the regression gate. Layer 2 (unrestorable snapshot) changes: the
   `restore_token` assertions become `BACKUP_NOT_FOUND` / `BACKUP_EXPIRED`
   checks against the native error codes.

## Risks / open questions

- **Beta breakage** on a load-bearing path. Mitigated by single-user blast radius
  + revert-to-custom rollback.
- **Security-model change.** The custom path gates restore with a constant-time
  `restore_token` compare against R2 metadata. Native restore is by `id`, gated
  only by "who can call `restoreBackup`" (our Worker + the route's owner-token).
  Confirm the route-layer owner-token check is sufficient for our threat model
  before dropping the token capability.
- **FUSE overlayfs restore semantics.** The restored `/workspace` is a CoW
  overlay. Verify git operations (commit, status, checkout of files) and
  subsequent `npm install` behave on the overlay — almost certainly fine, but
  it is a different substrate than a plain extracted dir.
- **Local-dev divergence.** `localBucket: true` *replaces* the dir on restore
  (no FUSE mount), so local smoke-test behavior differs from prod mount behavior.
- **Transition window.** Snapshots created by the custom path are not native
  backups; keep the old restore path alive until they age out (≤7 days) or
  accept that pre-migration snapshots become unrestorable.

## Graduation triggers

Promote from Draft to an implementation commitment (with a `ROADMAP.md` entry)
when either holds:

1. A real workspace approaches the 32 MB compressed ceiling (raise
   `PUSH_SMOKE_FILES` or seed a real repo against `scripts/snapshot-smoke/` to
   measure), **or**
2. We are doing other CF-sandbox work and want to retire the hand-rolled bytes
   opportunistically.

## Rollback

Because the change is two function bodies behind `SandboxProvider` + unchanged
routes, rollback is reverting those bodies (and re-pointing the index/reclaim).
Keep `SNAPSHOTS` bound through the first production cycle so a revert does not
strand in-flight resumes.

## Out of scope

GPU workloads (Modal-only). Modal's snapshot path (`snapshot_filesystem`) is
untouched. Per-user snapshot keying (still deferred until a stable per-user
identity exists, same as the index doc).
