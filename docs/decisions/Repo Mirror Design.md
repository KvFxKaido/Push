# Repo Mirror Design

Status: Proposed
Date: 2026-04-30
Reviewed by: Gemini, Codex (2026-04-30)

## Context

Push currently has a single delivery surface for GitHub data: a sandbox-mediated file viewer (`app/src/sections/FileBrowser.tsx`, `app/src/components/chat/hub-tabs/HubFilesTab.tsx`) that browses the working tree of a Cloudflare/Modal sandbox after `git clone`. This is great for "I am working on a workspace and want to inspect or download a file the agent produced," but it doesn't satisfy a different use case the user actually has.

**The use case driving this proposal:** the user keeps a full local mirror of their repos on their phone via the third-party Android app GitSync (`ViscousPot/GitSync`), then uploads root files (README, ROADMAP) to ChatGPT and Claude Projects mobile apps via Android's Storage Access Framework (SAF) file pickers.

## Strategic framing

**This is not a GitSync replacement.** GitSync's actual moat is automation — background sync via Android's WorkManager, schedules, widgets, quick tiles, sync-on-push via webhooks. Capacitor cannot match that without a multi-week native plugin investment, and even then the user mental model is "GitSync runs in the background; I forget about it" — fighting that on Push's terms means losing.

**This is an AI-aware repo mirror.** The wedge is exactly what GitSync structurally cannot offer:

- "Push noticed your README changed since last mirror — re-share to your Claude Project?"
- "Push noticed ROADMAP and CLAUDE.md drifted from their committed versions"
- "Open this README in Push chat" (uses Push's own AI on the file as context)

If we ship "GitSync but inside Push," users keep GitSync. If we ship "the only mirror that connects mirrored files to AI workflow," that's a real reason to switch. v1 establishes the file layer; v2 adds diff-awareness; v3+ layers AI features on top.

## Non-goals

- **Bidirectional sync.** GitSync supports commit/push from the phone; Push will not. This use case is read + share.
- **Background sync on a schedule.** Capacitor lacks first-party WorkManager equivalent. Manual + on-launch sync only.
- **Full git semantics in v1.** No branch UI, no merge conflict resolution, no LFS content fetching, no submodule recursion, no symlink fidelity. Each is documented as a known limitation; addressed in later versions or via the sandbox-export fallback (see below).

## Architectural decisions

### 1. GitHub-direct via Tree + Blobs API

Two paths considered:

- **A. Extend the existing sandbox flow.** Reuse `downloadFileFromSandbox` (which goes through a sandbox's filesystem after `git clone`) and add a "list all files recursively" endpoint. **Cons:** every sync requires spinning up a sandbox (cost, latency, ephemerality); couples mirroring to "have a workspace open"; doesn't match the user's mental model of "I keep the repo on my phone at all times."

- **B. GitHub-direct API calls from the SPA.** Use `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` and `GET /repos/{owner}/{repo}/git/blobs/{sha}`. **Cons:** new code path; constrained by GitHub's tree-truncation limits; misses real git semantics (LFS, submodules, exec bits, symlinks).

**Decision: B (GitHub-direct).** The cost analysis tipped further toward B once we discovered the SPA already calls `api.github.com` directly (see `app/src/hooks/useRepos.ts`) using token storage centralized in `app/src/lib/github-auth.ts`. No Worker proxy is needed for v1 — the existing pattern works.

**Documented future fallback:** for repos that hit GitHub API edge cases (LFS-heavy repos, deeply nested submodules, trees beyond GitHub's 100k-entry / 7MB recursive limit), reserve the option of "sandbox-as-export-proxy" — sandbox does the `git clone`, streams a tarball to the client, client extracts to the SAF folder. This handles the cases GitHub-direct cannot. v3+ feature; not in v1.

### 2. Storage abstraction (cross-platform, with honest scope)

The feature must work on Push's surfaces — Capacitor APK *and* PWA. SAF is native-only; if the feature were APK-only it would be a dead button on PWA, regressing surface parity. *However*, the cross-platform claim must be calibrated to platform reality, not over-sold.

**Decision: build a `MirrorTarget` abstraction with two roles:**

```typescript
interface MirrorTarget {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  finalize(): Promise<void>; // zip target triggers download here; folder targets no-op
}
```

| Target | Platforms | Role |
|--------|-----------|------|
| `CapacitorFolderTarget` (SAF) | Capacitor APK | **Primary mirror flow on mobile.** This is the product feature. |
| `FileSystemAccessTarget` (`showDirectoryPicker`) | Chromium web | Secondary — added when usage justifies the effort. |
| `ZipBundleTarget` (lazy-imported `jszip`) | All platforms | **Explicit "Download as zip" action**, separate UX from the mirror flow. One-shot grab without permission grants. Not a sync mechanism. |

**Why this framing matters (per Codex review):** calling zip a "Tier 2 honest degradation" is too generous — the user goal is "files on phone that other apps' SAF pickers can attach," and a zip in Downloads doesn't satisfy that until the user manually extracts it. The honest framing is "SAF is the feature; zip is a separate utility that's available everywhere."

**v1 ships `CapacitorFolderTarget` + `ZipBundleTarget`.** `FileSystemAccessTarget` is deferred until we see web users actually requesting persistent folder mirrors. The interface stays small enough that adding it later is straightforward.

### 3. Manifest-driven diff-awareness (with full git metadata)

On first sync, store a manifest in IndexedDB keyed by `repo_full_name` containing per-entry metadata. On subsequent syncs:

1. Fetch the fresh tree
2. For each entry, compare `(sha, mode, type, size)` against the manifest
3. Only fetch blobs whose **content** changed (`sha` differs)
4. Re-write file metadata (mode/type changes alone) without re-downloading content where possible
5. Delete files no longer in the tree
6. Atomically update the manifest, including `source_tree_sha` (the root tree SHA at sync time)

**Manifest entry schema:**

```typescript
interface ManifestEntry {
  path: string;
  sha: string;       // blob SHA (content-addressed)
  mode: string;      // 100644 | 100755 | 120000 | 160000 | 040000
  type: 'blob' | 'tree' | 'commit';
  size: number;
}

interface RepoManifest {
  full_name: string;
  source_tree_sha: string;  // root tree SHA at last sync
  source_ref: string;       // branch or commit ref
  last_synced_at: string;   // ISO timestamp
  folder_uri: string;       // SAF persistable URI
  entries: Record<string, ManifestEntry>;  // keyed by path
}
```

**Why every field matters:**

- `mode` distinguishes regular files (`100644`) from executables (`100755`), symlinks (`120000`), submodules (`160000`), and directories (`040000`). A chmod +x is a real change even when the blob SHA is unchanged.
- `type` separates `blob` (regular file) from `tree` (directory) and `commit` (submodule pointer). Submodules look like blobs to lazy code and break when fetched as such.
- `size` enables a quick sanity check before fetching (skip files claiming to be too large).
- `source_tree_sha` lets us short-circuit the entire diff pass: if the root tree SHA matches, nothing changed, skip the per-entry walk.

### 4. Conflict policy

If the user (or another app, or GitSync's local clone) modifies a file at the destination, sync **overwrites** it. Push presents itself as a read-only mirror, not a working tree. UI must be explicit: "Sync overwrites local changes."

## Git tree edge cases (v1 handling)

GitHub's tree API has real edges that the SHA-equality manifest must explicitly handle:

| Edge case | v1 behavior | Why |
|-----------|-------------|-----|
| **Submodules** (`type: commit`) | Skip; record as metadata-only entry in manifest with type=commit. | Submodule entries don't have a `blob` to fetch — they reference another repo's commit. Recursing them is a separate feature. |
| **Symlinks** (`mode: 120000`) | Skip with a warning surfaced in the sync summary ("3 symlinks skipped"). | Symlink content is the target path string, not file contents. Writing as a regular file is misleading; preserving symlinks via SAF is platform-fraught. v2 addresses if needed. |
| **LFS pointer files** | Detect by content (small file starting with `version https://git-lfs.github.com/spec/v1`), skip with warning. | LFS content lives at a separate endpoint with separate auth. v2 or v3+ if there's demand. |
| **Truncated tree responses** (`response.truncated === true`) | Refuse to mirror with a clear error: "Repo exceeds GitHub's tree-API limits (100k entries or 7MB). Use the sandbox-export fallback when available." | The user's repos are all well under the threshold. Subtree walking is v2 if encountered. |
| **Files >100MB** | Skip with warning. v2: fall back to `download_url` (raw.githubusercontent.com). | Blobs API base64 caps at 100MB. CORS on raw.githubusercontent.com needs a smoke test before relying on the fallback. |
| **Path collisions** (case-insensitive filesystems, Unicode normalization, paths colliding with `.git/` or `manifest.json`) | Sanitize paths: refuse paths containing `..`, `\\`, or starting with `.git/`. Surface case-collision warnings (two files differing only by case can't coexist on Android's typical FAT/exFAT external storage). | Path safety is non-negotiable; case-collisions are best-effort. |

## Failure modes

These are normal failure modes that v1 must handle gracefully, not exceptional cases:

1. **SAF permission revocation.** Persistable URI grants can be revoked by the user in Android settings or invalidated by provider updates. v1: detect grant failure on `writeFile`, surface "Folder access lost — re-grant to continue mirroring," restore via the same folder picker flow.

2. **IndexedDB eviction.** Mobile browsers and Capacitor WebViews under storage pressure can prune IndexedDB. If the manifest disappears for a repo previously marked as mirrored, the next sync degrades to a full re-download (still correct, just slower). UI surfaces "Manifest unavailable — next sync will re-fetch all files."

3. **Truncated trees.** Refuse to mirror; explain why; document the v3+ sandbox fallback as the resolution path.

4. **GitHub secondary rate limits.** Distinct from the 5000/hr primary limit, GitHub enforces concurrent-request and per-minute secondary limits. v1: cap blob-fetch concurrency at 6, honor `Retry-After` headers on 429/403 responses, exponential backoff on retries.

5. **Network failures mid-sync.** Partial syncs leave the manifest in an inconsistent state. v1: write the manifest only at the end of a successful sync (atomic update); abort cleanly on failure with all-or-nothing semantics for the manifest while leaving partial files on disk (better than no files).

6. **`server.url` plugin contract drift.** Because the WebView always loads fresh code from the Worker but native plugins are frozen in the APK, any SAF/folder-picker plugin contract must be backward-compatible. Old APK + new web code must keep working. Pick a plugin with a stable, simple interface (or a custom 50-line plugin we control).

## v1 scope

| Step | Effort |
|------|--------|
| `useRepoTree(fullName, ref)` hook (calls `/repos/{owner}/{repo}/git/trees/{ref}?recursive=1`, handles `truncated` flag) | ~1 hour |
| `fetchBlobBytes(fullName, sha)` helper (calls `/repos/{owner}/{repo}/git/blobs/{sha}`, base64-decode, size guard) | ~1 hour |
| `MirrorTarget` interface + `CapacitorFolderTarget` + `ZipBundleTarget` | ~half day |
| `useRepoMirror(repo)` orchestration: tree fetch → diff against manifest → parallel blob downloads (concurrency 6, with Retry-After handling) → write loop → atomic manifest update | ~half day |
| Edge-case handling: submodules skip, symlinks skip+warn, LFS detect+warn, truncation refuse, path sanitize | ~half day |
| SAF folder picker plugin choice + persistable URI grant + revocation detection | ~half day |
| Mirror UI: button row inline on repo list, progress, sync summary (N updated, M added, K deleted, X skipped) | ~half day |
| Tests: manifest schema, diff logic, edge-case branches | ~2–3 hours |

**Estimate: ~2.5 days for v1.**

The earlier ~1.5-day estimate underweighted edge-case handling and SAF failure modes. Council review (Gemini + Codex) made clear that v1 needs these to ship as more than a prototype.

**v2 candidates** (each ~half-day to ~1 day):
- Subtree walking when recursive tree is truncated
- LFS content fetching for repos that need it
- File System Access API target on Chromium web
- Symlink fidelity where the target platform supports it

## Open questions

1. **Where does the entry point live on the repo list?** Inline button vs. dedicated screen vs. settings-buried. Tentative: inline on repo list — discoverable, matches user mental model, no new screens.

2. **SAF folder picker plugin choice.** Community plugin (`@capacitor-community/file-picker`) ships faster but adds dep weight. A 50-line custom plugin is leaner but requires Android plugin development. Both must respect the `server.url` contract-stability constraint. Tentative: custom plugin, since the surface area is small and contract control is valuable.

3. **Should "Download as zip" be exposed alongside SAF mirror on Android?** Useful for one-shot grabs without permission grants. Cheap to add. Tentative: yes, expose as a secondary action on every platform.

4. **Branch selection.** v1 defaults to default branch. A picker is v2 unless usage shows demand.

## What this enables

The `CapacitorFolderTarget` + `ZipBundleTarget` infrastructure is the right shape for *any* future feature that lands data on disk: drafts export, prompt library export, conversation export. Building it once for the repo mirror means cross-platform file-write infrastructure is available for future features at near-zero marginal cost.

The manifest substrate enables the v3+ AI features that justify building this *into* Push at all:

- "Push noticed your README changed since last mirror" (manifest comparison + push notification)
- "Open this mirrored file in Push chat" (one-tap context attachment)
- "Push noticed ROADMAP drifted from its committed version" (local manifest vs. fresh tree comparison)

None of these are in v1. v1 is the file layer. The AI-awareness is the reason the file layer is worth owning.
