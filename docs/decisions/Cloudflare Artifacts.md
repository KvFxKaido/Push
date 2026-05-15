# Cloudflare Artifacts

Status: Draft, added 2026-05-14
Origin: [cloudflare/artifact-fs](https://github.com/cloudflare/artifact-fs) (public beta), [Cloudflare Sandbox Provider Design](Cloudflare%20Sandbox%20Provider%20Design.md), [CF Containers FUSE changelog 2025-11-21](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/)

## Context

Cloudflare published `artifact-fs` as a public open-beta — a FUSE driver that mounts a git tree instantly and hydrates blobs on demand. The pitch ("tree in milliseconds, files stream as you touch them") maps directly onto Push's biggest cold-start UX surface: the moment a user opens a repo and waits for `sandbox.gitCheckout` to return before anything else can happen.

We evaluated dropping `artifact-fs` into the `cloudflare` sandbox backend in place of the `sandbox.gitCheckout` call inside `routeCreate` (see `app/src/worker/worker-cf-sandbox.ts`). Both unknowns we worried about resolved in favor of feasibility:

- **FUSE in CF Containers is real and shipped.** `@cloudflare/sandbox` has been mounting R2 buckets via s3fs-FUSE since v0.5.1 (we run 0.8.11); CF Containers gained platform-level FUSE on [2025-11-21](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/). `/dev/fuse` and `CAP_SYS_ADMIN` are present in the base image without any `wrangler.jsonc` capability config.
- **`artifact-fs` works against arbitrary GitHub URLs.** README is explicit: *"it also works with any git repo."* Credentials pass through in the clone URL exactly like Push's current `https://x-access-token:${githubToken}@github.com/${repo}.git` pattern. No registration into a Cloudflare Artifacts namespace required.

Despite both gates clearing, we deliberately did not ship the integration. This doc records why and what would change the answer.

## Why we did not ship now

1. **The CDN payoff is gated on closed beta.** `artifact-fs`'s genuine speed advantage comes from blob hydration hitting Cloudflare's edge cache — which requires Cloudflare Artifacts the **storage product** to be the backing store. Cloudflare Artifacts is still closed/private beta. Pointed at raw GitHub, `artifact-fs` is FUSE wrapped around git's own partial-clone machinery: all of the FUSE risk surface, none of the edge-cache win. The interesting integration unlocks when (and only when) we can host the backing store on Cloudflare Artifacts itself.

2. **We don't yet know that clone is the bottleneck.** The block-comment in `routeCreate`'s cache-populate step (the `cp -al` hardlink copy from `/opt/push-cache/node_modules`) is explicit that the dominant cold-start cost on Push has historically been a `~100s` cold `npm install`, not git clone — that's the entire reason the cache exists. Without per-phase ready-state timing, swapping the clone path is a guess. If git clone turns out to be a single-digit percentage of cold-start, `artifact-fs` returns ≈0 even when it works perfectly.

3. **The cache trick breaks on a FUSE workspace.** `cp -al` cannot hardlink across filesystems. With `/workspace` mounted via FUSE and `/opt/push-cache/node_modules` on ext4, the existing hot-path optimization either no-ops or falls back to a full copy. So `artifact-fs` simultaneously: (a) makes git clone faster, and (b) makes the much-larger `node_modules` populate step slower or impossible. Net effect on ready-state is genuinely unclear and could be negative.

4. **FUSE semantics are a quiet correctness risk for agents.** Push's reliability story rests on every tool — `sandbox_read_file`, `sandbox_write_file`, `sandbox_exec`, `sandbox_diff` — seeing a filesystem that behaves exactly like the agent expects. FUSE filesystems have well-known edge cases (rename across mount points, fstat caching, `O_TMPFILE`, partial-write visibility under concurrent readers) that a tuned ext4 workspace doesn't. "Looks normal until it doesn't" is the worst class of regression for an agent that lives or dies by reliable tool execution.

5. **Beta-on-beta.** `artifact-fs` README explicitly says *"Your mileage may vary."* Pairing a beta FUSE driver with a beta sandbox runtime, on a hot-path that decides whether every Push session opens fast or breaks, is a poor leverage point.

## What we shipped instead in this branch

The branch `claude/add-cloudflare-artifacts-QSk0x` (commit `4e0c12f`) lands two narrow changes that do not commit Push to `artifact-fs`:

- **Per-phase ready-state instrumentation** in `routeCreate`, emitted as a single `cf_sandbox_create_timing` log line covering `git_identity`, `clone`, `cache_populate`, `seed_files`, `probe`, `token_issue`, plus total wall time and the failing phase (when applicable). This is the data we need to know whether `clone` is worth optimizing at all.
- **`depth: 1`** on `sandbox.gitCheckout`. Push sessions only ever operate on the branch tip; the full history pack is pure cold-start tax. SDK-supported, no fallback path required.

These changes survive any future decision about `artifact-fs`: the timing tells us where ready-state goes, and the shallow clone is unambiguously better whether or not we ever mount a FUSE tree on top.

## Triggers for revisiting

Promote this draft to an implementation decision only when **both** of the following hold:

1. **Cloudflare Artifacts (the storage product) opens for our account** so blob hydration can hit the CF edge cache. Without that, `artifact-fs` over raw GitHub is not an interesting bet.
2. **The `cf_sandbox_create_timing` histogram shows `clone` as a meaningful fraction of cold-start** — call it >25% of `total_ms` across a representative sample of real sessions. If `cache_populate` or `probe` dominate, the optimization budget belongs elsewhere.

A weaker trigger that wouldn't promote this doc but would justify a follow-up spike: `clone` being >15% AND a Push-tuned partial-clone variant (`--filter=tree:0` for tree-only fetch with greedy blob prefetch of likely-touched files) is materially worse than the SDK's `depth: 1` plus the existing cache.

## What a future implementation would look like

When the triggers fire:

1. Multi-stage `Dockerfile.sandbox`: `FROM golang:1.24-bookworm AS afs-builder` to build `artifact-fs` from a pinned sha (no release binaries today), runtime stage installs `fuse3`, copy binary to `/usr/local/bin/artifact-fs`.
2. Behind a `PUSH_ARTIFACT_FS` env var in `wrangler.jsonc` (default off), `routeCreate` replaces `sandbox.gitCheckout` with `artifact-fs daemon` + `artifact-fs add-repo --mount-root /` mounted at `/workspace`.
3. **Hard fallback to `sandbox.gitCheckout` on any error** — beta dep, hot path, no exceptions.
4. Resolve the cache-hardlink question explicitly: either (a) accept the regression and rely on edge-cached blob hydration to win the overall comparison, or (b) mount `artifact-fs` at `/workspace-src` and continue materializing a real `/workspace` from it (loses the lazy-hydration win, retains the cache).
5. Smoke-test under `wrangler dev` with explicit checks for: rename-across-mount, large-file write under read load, `git status` correctness inside the mount, agent tool-execution parity against an ext4 baseline.

None of (1)-(5) should land until the triggers fire.

## Open questions

- **Does Cloudflare publish a way to register an existing GitHub repo into Cloudflare Artifacts on demand?** If we have to mirror the user's repo into CF Artifacts before mounting it, the latency of that mirror step needs to be smaller than the clone time we'd save, every cold start. Looks unlikely without long-lived per-user storage.
- **Does `artifact-fs` support writes through the mount?** README is silent. Coder writes files constantly; if `/workspace` becomes read-only-ish we need a writable overlay (overlayfs on top of FUSE) and the architecture gets meaningfully more complex.
- **What's the daemon lifecycle inside a sandbox container?** `artifact-fs daemon` is long-running. We'd need a supervisor strategy (process restart, health probe) inside containers that are themselves short-lived.

## Decision (pending)

Not adopted. Reconsider when the two triggers above both hold. Until then, the canonical clone path stays `sandbox.gitCheckout(... { depth: 1 })`, the cache stays the `cp -al` hardlink from `/opt/push-cache`, and the data we need to make a real decision is collected by the `cf_sandbox_create_timing` log line.
