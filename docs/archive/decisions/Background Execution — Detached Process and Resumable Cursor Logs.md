# Background Execution — Detached Process and Resumable Cursor Logs

**Status:** Merged into [`Platform, Sessions, and Sandbox Decisions.md`](<../../decisions/Platform, Sessions, and Sandbox Decisions.md>) (§6). Added 2026-06-04 as Draft; mechanism **shipped in PR #789** — worker routes (`exec-start`/`-status`/`-logs`/`-kill`), `SandboxProvider` wiring behind `capabilities.backgroundExec` (CF `true`, Modal `false`), the shared `lib/detached-exec-runner.ts` run-to-completion kernel, and the first consumer (cold `npm install` in `handleCheckTypes` via `execLongRunningInSandbox`), with transparent fallback to buffered `exec` on backends without the routes. **Promoted 2026-06-09:** agent `sandbox_exec` adoption is now a `ROADMAP.md` entry (Background Exec Adoption — `sandbox_exec` Detached Path), motivated by the idle-reaper incident behind PR #861 — buffered exec's ~165s deadline makes long test runs impossible on web. DO-lifetime assumption **verified live** (see Evidence).

## Problem

`SandboxProvider.exec()` is a single **buffered** call: it returns one `ExecResult`
(`stdout`/`stderr`/`exitCode`/`truncated`) only when the command finishes. That shape
has three standing costs, all already felt:

1. **No live output.** A 100s cold `npm install` (see [`push-sandbox-stall-resolution`])
   produces zero output until completion, so the agent/UI can't tell a slow command from
   a wedged one.
2. **Tail loss.** Long test runs hit the `truncated` cap and the part you actually want —
   the failure at the end — is the part that gets dropped.
3. **No survival across disconnects.** This is the sharp one. A mobile session that drops
   mid-command loses the stream *and usually the command*, because nothing is detached.
   This is the exact failure mode in [`push-hybrid-remote-local-sessions`] — a long local
   command stranding an Android session for a workday.

The CF worker already documents the underlying limit in `worker-cf-sandbox.ts`: *"the
Cloudflare Sandbox SDK's exec has no abort path — if the container is wedged … the
returned promise never resolves."* True for the **blocking** `exec()` Push uses — but the
SDK ships a whole detached-process family Push never adopted.

## Reference

Modeled on Alibaba **OpenSandbox**'s `execd` daemon ([repo](https://github.com/alibaba/OpenSandbox),
[`specs/execd-api.yaml`](https://github.com/alibaba/OpenSandbox/blob/main/specs/execd-api.yaml)):
`POST /command {background:true}` returns a command id immediately, then
`GET /command/status/{id}` and `GET /command/{id}/logs?cursor=N` (with an
`EXECD-COMMANDS-TAIL-CURSOR` response header) provide poll-based status and **incremental,
resumable** log reads. `DELETE /command?id=` interrupts; every call takes a server-enforced
`timeout`. We borrow the *contract shape*, not the daemon — it's self-hosted Docker/K8s and
the wrong operational fit (see the broader read in chat history; not adopted as a backend).

The non-obvious insight: the resumability win is **cursor polling, not SSE.** SSE dies on
disconnect (so does the SDK's `streamProcessLogs`); cursor polling is resumable by
construction — the command keeps running detached and a reconnecting client re-requests
from its last cursor. That is precisely what fixes the mobile-disconnect case.

## What's free in the installed SDK

`@cloudflare/sandbox@0.8.11` already exposes the primitives. Push uses ~⅓ of its execution
surface:

| execd contract | CF Sandbox SDK 0.8.11 |
|---|---|
| `POST /command {background:true}` → id | `startProcess(cmd, opts)` → `Process { id }` |
| `GET /command/status/{id}` | `getProcess(id)` → `status`/`exitCode`/`startTime`/`endTime` |
| `DELETE /command?id=` | `killProcess(id, signal)` |
| server-side `timeout` (ms) | `BaseExecOptions.timeout` (also added to buffered `exec()`) |
| `GET /command/{id}/logs?cursor=N` | `getProcessLogs(id)` → `{stdout, stderr}` ⚠️ **no cursor** |

The **one gap** is the cursor: `getProcessLogs` returns the *full accumulated* buffer every
call. We layer the cursor worker-side (option **b** of the chat analysis) — fetch the full
buffer, slice from the caller's byte offset, return the new length as the next cursor.
Cheap at npm-install/test-run log sizes; the seam to swap for a tail-only fetch if buffers
ever grow huge is isolated to `routeExecLogs`.

A second non-obvious trap: `ProcessOptions.autoCleanup` **defaults to `true`**, which purges
the process record on exit — dropping final status and logs the instant a command finishes,
silently breaking reconnect-after-completion. We set `autoCleanup: false`; teardown (or an
explicit kill) is the reclaim path.

## Design (prototype as landed)

Four additive worker routes in `app/src/worker/worker-cf-sandbox.ts`, all behind the
existing owner-token gate, all plain request/response JSON (no streaming-through-DO — that
question is sidestepped entirely):

- `exec-start` → `startProcess(cmd, {cwd?, timeout?, autoCleanup:false})` → `{process_id, status, running, started_at}`
- `exec-status` → `getProcess(id)` → `{status, running, exit_code, started_at, ended_at}`; `null` → terminal `NOT_FOUND` (callers stop polling)
- `exec-logs` → `getProcessLogs(id)` + worker-side cursor → `{stdout, stderr, next_cursor_stdout, next_cursor_stderr, truncated}`; cursor advances only by what was returned, so a truncated read stays resumable
- `exec-kill` → `killProcess(id, signal?)`, idempotent (logs a noop)

Buffered `exec()` is **untouched** except for an additive `timeout_ms` passthrough (clamped
to the container ceiling so it can only tighten, never extend past the safety net) — the
free, independently-landable win that gives callers a real per-command deadline.

The buffered path stays the default; background is the additive layer for long-running work.

## Evidence (live test, 2026-06-04)

Ran against a real local CF container under `wrangler dev` (the unit suite mocks
`getSandbox`, so it cannot answer this — only a real container can). Scratch sandbox,
20×1s line emitter:

- **Cross-request persistence:** a fresh request read the process `exec-start` created in an
  *earlier* request. ✅
- **Incremental cursor:** req A (cursor 0→28) returned `line 1-4`; req B (cursor 28→56)
  returned `line 5-8` *only* — not a re-dump. ✅
- **Status survives + flips:** later request saw `completed / running:false / exit_code:0 /
  ended_at`. ✅
- **Post-exit log survival (`autoCleanup:false`):** read from cursor 0 after exit returned
  all 20 lines. ✅
- **Idempotent kill on a finished process:** `{ok:true}`. ✅

The load-bearing assumption — a detached process and its log buffer outlive the request that
spawned it — holds on the real DO-backed container.

## Scorecard

~80% free in the installed SDK; ~15% a thin worker-side cursor we control; the remaining
~5% was the DO-lifetime assumption, now verified rather than assumed.

## Follow-on (to graduate)

1. ~~**Provider wiring.**~~ **Done.** Optional `execBackground` / `execStatus` / `execLogs` /
   `execInterrupt` added to `SandboxProvider` (`lib/sandbox-provider.ts`) + implemented in the
   CF client (`app/src/lib/cloudflare-sandbox-provider.ts`), behind the new
   `capabilities.backgroundExec` flag (CF `true`, Modal `false`) — same branch-on-capability
   pattern as `snapshots`. `ExecOptions.timeoutMs` also threaded into buffered `exec()`.
2. ~~**Tests.**~~ **Done.** Worker route tests (cursor math, `NOT_FOUND` mapping, idempotent
   kill, clamp, `autoCleanup:false` assertion) + provider mapping tests (snake↔camel, body
   shaping, capability). No new runtime envelope/tool vocabulary was added (these are
   provider HTTP routes gated by the existing owner-token + `ROUTES` set), so no
   protocol-drift pin is required.
3. ~~**Consumer.**~~ **First one done.** The cold `npm install` in `handleCheckTypes` is the
   first caller (the most visible cold-install pain). Implementation split for reuse: a
   surface-agnostic `lib/detached-exec-runner.ts` kernel (`runDetachedToCompletion` — polls
   status, drains cursor logs, enforces an overall deadline, injectable timers) +
   `execLongRunningInSandbox` in `sandbox-client.ts` (thin fetch wrappers + the 404→buffered
   fallback) + an optional `execLongRunning` on `VerificationHandlerContext`, wired in the
   dispatcher. **Still open:** the agent's own long `sandbox_exec` runs (live progress +
   reconnect) and `verify_workspace`'s install step — natural next adopters of the same
   kernel; pairs with the remote-sessions relay.
4. **Cursor scale.** Swap full-buffer-slice for a tail-only read only if real log sizes make
   the re-fetch wasteful — don't pre-optimize.

## Known follow-ups (from the 2026-06-04 review pass)

Correctness items #1–#5 from the high-recall review were fixed in-branch (unguarded
mid-run drain, `exitCode ?? 0` masking abnormal exit, `exec-*` missing the retry opt-out,
deadline not re-checking status, byte-vs-UTF-16 cursor misnomer + surrogate-split guard).
These remain open:

- **#6/#10 — silent/fragile fallback. FIXED.** The runner's contract is now crisp: it
  throws **only** if the command never started; every post-start outcome (clean/abnormal
  exit, lost contact, deadline) resolves to an `ExecResult`. So `execLongRunningInSandbox`'s
  fallback is unambiguous — it fires only on a genuine start failure (route absent OR a
  failed/timed-out launch, all safely handled by buffered exec), and **emits a
  `background_exec_fallback` structured log** so the downgrade (and any lost `onProgress`)
  is observable instead of silent. A mid-run status error no longer propagates (which would
  have re-run an already-running command); it resolves to a `-1` failure the caller surfaces.
  The `exec` retry opt-out was also narrowed to the command-launchers (`exec`/`exec-start`)
  so cheap status/log polls still recover from transient blips.
- **#7 — the unconsumed provider copy. Reframed, deliberately kept.** This is **not** a
  background-exec-specific dead-code issue: `createSandboxProvider` has zero callers, so the
  *entire* `SandboxProvider` class (`exec`/`readFile`/`snapshot` included) is unconsumed by
  design — the web tool path runs on `sandbox-client.ts`. The background-exec methods mirror
  that existing pattern rather than adding new asymmetry, so cherry-pick-deleting only them
  would be inconsistent. The real item is the larger **"adopt `SandboxProvider` in the web
  tool path"** initiative (which would also let the fallback key off
  `capabilities.backgroundExec` instead of catching a start error) — tracked separately, out
  of scope here.
- **#8 — O(n²) log transfer.** `exec-logs` re-fetches the full accumulated buffer every
  poll (the SDK has no cursored read) and slices worker-side. Fine at install/test-run
  sizes; swap for a tail-only fetch if a chatty long-running consumer is added. Status +
  logs are also two round-trips per poll — combinable.
- **#9 — `markWorkspaceMutated` on the detached path.** Accepted but only forwarded on the
  buffered fallback; the detached `exec-start` drops it. Inert on CF (revision hardcoded 0)
  and correct on Modal via fallback, but will bite when a backend tracks real revisions.

## Related

- [`Cloudflare Sandbox Provider Design.md`](Cloudflare%20Sandbox%20Provider%20Design.md) — the provider this extends
- [`Cloudflare Native Backup Migration.md`](Cloudflare%20Native%20Backup%20Migration.md) — the other "adopt SDK-native primitives we hand-rolled around" move
- `push-hybrid-remote-local-sessions`, `push-sandbox-stall-resolution` — the motivating pain
