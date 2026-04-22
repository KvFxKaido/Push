# Cloudflare Sandbox Provider Design

Date: 2026-04-20
Status: **Shipped** — PRs #353, #354, #355, #356 merged
Owner: Push
Related: `docs/decisions/Modal Sandbox Snapshots Design.md` (sibling provider),
`docs/decisions/AgentScope Architecture Review.md` (origin of the `SandboxProvider` interface),
`lib/sandbox-provider.ts`, `app/src/worker/worker-cf-sandbox.ts`,
`app/src/lib/cloudflare-sandbox-provider.ts`, `app/src/worker/sandbox-token-store.ts`,
`Dockerfile.sandbox`

## Shipping status

| PR | Scope | Merged |
|---|---|---|
| #353 | CF Sandbox provider scaffold: Dockerfile, wrangler bindings, HTTP handler, client adapter, provider selector, server-side dispatch | 2026-04-20 (`7899d92b`) |
| #354 | Vitest coverage for `/api/sandbox-cf/*` routes (26 tests) | 2026-04-20 (`b57f8141`) |
| #355 | Owner-token auth via `SANDBOX_TOKENS` KV namespace with timing-safe compare, OOM cap, and fail-closed semantics | 2026-04-20 (`6e7e393b`) |
| #356 | In-container streaming reads via `sed` / `stat` / `sha256sum` / `awk` — Worker memory bounded to the returned slice | 2026-04-20 (`c27a02d0`) |

## Problem

Push's sandbox was Modal-only from inception. Modal is a great fit for Python-heavy workloads and GPU, but the sandbox surface for Push is predominantly TypeScript — and the Worker that fronts Modal already runs on Cloudflare. Paying round-trip latency from CF edge → Modal region → back to CF Worker for every sandbox op is dead weight when Cloudflare Sandbox SDK went GA (2026-04-13) and runs the container directly on the same platform.

Beyond latency, Modal's free tier is generous but gates paid scaling behind a sales conversation. Cloudflare's Workers Paid plan ($5/mo) includes sandbox time on a self-serve active-CPU pricing model that aligns naturally with agent workloads (long idle during LLM token streaming, short bursts on exec). Infra direction for Push, captured on 2026-04-20 (`push-infra-direction` memory), is Cloudflare-first across compute / sandbox / AI / storage.

## Goal

Ship a Cloudflare Sandbox backend behind the existing `SandboxProvider` interface so that:

1. Both providers coexist with identical HTTP wire format (`/api/sandbox/*`), selected server-side via `PUSH_SANDBOX_PROVIDER` with a deploy-time flip.
2. Client code — web UI, CLI, shared `sandbox-tools.ts` — doesn't change between backends. The provider abstraction absorbs the difference.
3. Security posture matches Modal (owner-token auth, origin check, rate limit, fail closed on missing bindings).
4. Memory posture on large reads is bounded regardless of file size.

## Non-goals

- **Filesystem snapshots parity with Modal.** Modal exposes image-level snapshots; the Sandbox SDK doesn't. Follow-up work will add R2-backed tar.gz snapshots to close this.
- **GPU workloads.** Cloudflare Containers don't currently offer GPU. Modal stays the escape hatch for GPU-dependent sandbox work.
- **Workspace-revision parity.** The SDK doesn't expose Modal's monotonic workspace counter. File-level SHA-based concurrency still works; workspace-level optimistic concurrency does not (yet).

## Architecture

### Wire format

`/api/sandbox/*` POST requests dispatch to `handleCloudflareSandbox` (from `worker-cf-sandbox.ts`) when `env.PUSH_SANDBOX_PROVIDER === 'cloudflare'`, else fall through to the existing `handleSandbox` (Modal). A secondary route `/api/sandbox-cf/*` always goes to the CF handler regardless of the var — useful for A/B debugging and forced-CF testing without redeploy.

Both handlers share an identical snake_case wire format — Modal's convention (`sandbox_id`, `owner_token`, `github_token`, `github_identity`, `seed_files`, `workspace_revision`, `exit_code`, …). A client can target either handler with the same request body; the `PUSH_SANDBOX_PROVIDER` toggle is the only thing that changes backends on `/api/sandbox/*`. The TypeScript result shapes in `lib/sandbox-provider.ts` are intentionally mixed: lifecycle/session/exec types use camelCase (`sandboxId`, `ownerToken`, `exitCode`, `workspaceRevision`), while file-operation results (`FileReadResult`, `WriteResult`, `BatchWriteResult`, `DiffResult`) keep snake_case keys (`workspace_revision`, `bytes_written`, `new_version`, `git_status`, …) so they can be returned verbatim from the wire. Each provider's adapter only transforms the former group.

### `SandboxProvider` interface

Existing (`lib/sandbox-provider.ts`, authored as part of the original AgentScope refactor). Two sibling implementations:

- `ModalSandboxProvider` — wraps the pre-existing `sandbox-client.ts` HTTP functions against Modal's FastAPI endpoints.
- `CloudflareSandboxProvider` — talks to `/api/sandbox-cf/*` via `fetch`, caches owner tokens in a per-instance `Map` keyed by `sandboxId`, and injects the token into every non-create request body.

`createSandboxProvider({ provider })` picks between them. Browser/Worker contexts pass the name explicitly (no `process.env`); CLI contexts default to a Modal fallback when `PUSH_SANDBOX_PROVIDER` is unset, to match the conservative "if you didn't configure it, don't auto-switch backends" principle.

### Owner-token auth (PR #355)

Every non-create route gates on a token minted at sandbox creation time:

- **Storage**: `SANDBOX_TOKENS` KV namespace, key `token:<sandboxId>`, value `{ token, createdAt, ownerHint? }`, TTL 86,400 s (24 h safety net if `routeCleanup` doesn't run).
- **Mint**: `issueToken` called after all provisioning succeeds in `routeCreate`. The same token is also written into `/tmp/push-owner-token` inside the sandbox. If either KV write or file write fails, `routeCreate` destroys the sandbox before propagating the error — no orphaned unreachable containers.
- **Verify**: normal routes verify against the sandbox-local token file first, using the same timing-safe compare + input-length cap (256 bytes, OOM defense) as the old KV path. This intentionally keeps the auth hot path on the sandbox DO itself, avoiding false "session expired" failures from Workers KV propagation lag across PoPs. `cleanup` still falls back to KV so a dead sandbox can be torn down if its token file is already gone.
- **Revoke**: `routeCleanup` calls `revokeToken` after `sandbox.destroy()` succeeds. If destroy throws, the KV token survives so the caller can retry cleanup; KV TTL still sweeps up orphans.

The dispatcher still wraps auth verification in a local try/catch that returns a fail-closed 503 on unexpected throws.

### In-container reads (PR #356)

Original `routeRead` loaded the entire file into Worker memory via `sandbox.readFile`, which breaks on multi-MB files (Worker has a 128 MB cap, JS strings are UTF-16 so a 50 MB text file → ~100 MB). After #356:

- **Content slice**: `sed -n 'S,Ep' -- 'PATH' | head -c CAP+1` for line-range; `head -c CAP+1 -- 'PATH'` for unbounded. The `CAP+1` probe detects real truncation (content > CAP means overflow; exact-at-CAP reads cleanly).
- **Version hash**: `sha256sum -- 'PATH' | awk '{print $1}'` — streams through sha256sum's buffer, never hits Worker memory.
- **Line count** (only for range reads): `awk 'END{print NR}' -- 'PATH'` — portable, correct for files without trailing newline (`wc -l` undercounts by one in that case).
- **Existence probe**: `stat -c %s -- 'PATH'` — fails fast, returns size for accurate `remaining_bytes`.

All four commands run in parallel via `Promise.all`. Worker memory footprint drops to `O(slice size) + 64 bytes`.

### Shell quoting

Paths interpolated into `sandbox.exec` commands go through `shellSingleQuote`, which wraps in single quotes (suppressing all POSIX shell expansion) and escapes embedded single quotes via the `'\''` close-escape-reopen trick. `JSON.stringify` is unsafe for this purpose — it produces double-quoted strings that still evaluate `$VAR`, backticks, and `$(...)`, allowing command injection via crafted filenames.

## Known gaps (follow-ups)

- **No snapshots**: `capabilities.snapshots = false`; `hibernate` / `restore-snapshot` routes return HTTP 501. Follow-up: R2-backed tar.gz archives with the same index pattern as Modal's `SNAPSHOT_INDEX` (separate KV namespace per the per-provider prefix discipline).
- **Workspace-revision = 0**: The SDK doesn't expose a monotonic counter. File-level SHA still gates stale writes; workspace-level optimistic concurrency doesn't work on the CF path.
- **No persistence across provider restarts**: the `ownerTokens` Map on `CloudflareSandboxProvider` lives in-memory. Browser reload loses tokens; callers must invoke `connect(sandboxId, ownerToken)` with a persisted token to re-establish. Modal has equivalent via `safe-storage`; the CF path hasn't wired that yet.
- **CLI still defaults to Modal**: `resolveDefaultProvider()` in `modal-sandbox-provider.ts` falls back to `"modal"` when `PUSH_SANDBOX_PROVIDER` is unset. Web is CF-default via wrangler vars; CLI is Modal-default pending CLI-against-CF test coverage.
- **Deploy requires operator setup**: `SANDBOX_TOKENS` is intentionally absent from the default `wrangler.jsonc` because a placeholder id would break `wrangler deploy`. Operator must run `npx wrangler kv:namespace create SANDBOX_TOKENS` and add the binding before first CF-backed deploy.

## Operator setup

Before first deploy with `PUSH_SANDBOX_PROVIDER=cloudflare`:

```bash
# 1. Create the KV namespace for owner tokens.
npx wrangler kv:namespace create SANDBOX_TOKENS
# → outputs: { binding: "SANDBOX_TOKENS", id: "<namespace_id>" }

# 2. Add the binding to wrangler.jsonc under kv_namespaces.
#    Paste alongside the existing SNAPSHOT_INDEX entry:
#    { "binding": "SANDBOX_TOKENS", "id": "<namespace_id>" }

# 3. Ensure PUSH_SANDBOX_PROVIDER is set to "cloudflare" (or "modal" to opt out).
#    Defaults to "cloudflare" in the committed wrangler.jsonc.

# 4. Deploy.
npx wrangler deploy

# 5. (Optional) Flip providers without code changes:
#    npx wrangler deploy --var PUSH_SANDBOX_PROVIDER:modal
```

Without the `SANDBOX_TOKENS` binding, every CF sandbox route fails closed with `NOT_CONFIGURED` 503. Modal path is unaffected.

Local dev (`wrangler dev`) requires Docker Desktop (or equivalent) running — Wrangler builds the container image locally the first time, then caches. Alternative: develop against the deployed edge via `wrangler deploy` iterations.

## Security properties

| Threat | Mitigation |
|---|---|
| Sandbox-id guessing | Owner-token required; UUID tokens with timing-safe compare |
| Token-length OOM attack | 256-byte cap on provided token before any encoding |
| Command injection via filename | Single-quote shell escaping (`shellSingleQuote`) |
| Tar path traversal on hydrate | Archive members listed and rejected before extract if any starts with `/` or contains `..` |
| Orphaned unreachable sandboxes | `routeCreate` destroys the sandbox if token issuance fails after provisioning |
| Silent auth bypass when KV is unbound | Fail closed at every route including create |
| Malformed KV records | `isTokenRecord` type guard; non-object / non-string-token entries → NOT_FOUND |

## Appendix: session context

All four PRs shipped in a single session (2026-04-20) using a mixed-model workflow:

- **Claude (Opus 4.7)** handled security-critical + architectural work: provider scaffolding, owner-token design, dispatcher wiring, rebase-time test fixups.
- **Codex (gpt-5.2-codex via MCP)** handled mechanical/well-specified work: Vitest coverage (#354), streaming-reads refactor (#356) to a specified shell-command design.

The split pattern is captured in the `push-codex-claude-track-split` feedback memory.
