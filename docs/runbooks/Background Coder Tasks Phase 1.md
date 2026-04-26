# Background Coder Tasks — Phase 1

Date: 2026-04-21
Status: **planned** (scoped, not started)
Owner: Push
Supersedes status only of: `docs/runbooks/Background Coder Tasks Plan.md` — that doc remains the multi-phase design reference; this doc is the concrete Phase 1 implementation sketch.

## Goal

User can start a Coder-delegation task from web chat, lock the phone for 5+ minutes, and on reconnect see the task still running or completed with the full event timeline. Nothing else.

Non-goals: push notifications, retry/backoff, task-graph/explorer/reviewer in the background, auditor in background, job history UI, per-user sandbox token keying, interactive checkpoint prompts.

## 1. Current call graph (browser only today)

The Coder loop that we need to move is the one started by a `delegate_coder` tool call. Everything up to and including the loop currently runs in the tab.

1. Chat input enters `app/src/hooks/useChat.ts` (1365 lines). Send path is extracted into `app/src/hooks/chat-send.ts` (`streamAssistantRound`, `processAssistantTurn`) — this is the **Orchestrator** turn loop and stays client-side in Phase 1.
2. When the model emits `delegate_coder`, dispatch goes through `app/src/hooks/useAgentDelegation.ts:290` into `handleCoderDelegation(buildCoderContext(), …)` in `app/src/lib/coder-delegation-handler.ts`.
3. The handler calls `runCoderAgent` — the **Web shim** at `app/src/lib/coder-agent.ts:167` wires 10 DI slots and delegates to the headless kernel at `lib/coder-agent.ts:1126` (the `for (let round = 0; ; round++)` loop is at `lib/coder-agent.ts:1257`, capped by `MAX_CODER_ROUNDS = 30` at `lib/coder-agent.ts:75`).
4. Each round the kernel calls the injected `toolExec` closure. The Web shim's closure runs `executeSandboxToolCall` in `app/src/lib/sandbox-tools.ts`, which HTTP-POSTs to `/api/sandbox/*` (Modal) or `/api/sandbox-cf/*` (CF Sandbox DO). The Worker at `app/worker.ts:84,96` selects via `PUSH_SANDBOX_PROVIDER` (default `"cloudflare"`, `wrangler.jsonc:23`).
5. Sandbox auth uses owner tokens in `SANDBOX_TOKENS` KV (`wrangler.jsonc:55`, `app/src/worker/worker-cf-sandbox.ts:132,210,265`).
6. Results flow back as `RunEvent`s — canonical `RunEventInput` union at `lib/runtime-contract.ts:255`, persisted `RunEvent = RunEventInput & { id; timestamp }` at `lib/runtime-contract.ts:372`. Cap 400/chat via `MAX_RUN_EVENTS_PER_CHAT` (`lib/run-events.ts:3`).

**The sandbox itself is already server-side.** Phase 1 only moves the orchestration of the Coder sub-loop.

## 2. Minimum server-side surface

The Coder loop kernel is already extracted to `lib/coder-agent.ts` (Phase 5D landed this). A Worker/DO can re-bind the same `CoderAgentOptions` without forking logic. The 10 DI slots that need server-side substitutes:

| Slot | Web binding | DO binding (Phase 1) |
|---|---|---|
| `streamFn` | `getProviderStreamFn(activeProvider)` in `app/src/lib/orchestrator.ts` | Call existing `/api/<provider>/chat` endpoints from the DO (see `app/worker.ts:240-263`) |
| `toolExec` | `executeSandboxToolCall` over `fetch('/api/sandbox/*')` | Same fetch shape; call `/api/sandbox-cf/*` over the Worker's own origin |
| `userProfile` | `getUserProfile()` (localStorage) | Pre-serialized `UserProfile` snapshot in the POST body |
| `taskPreamble` | built from `DelegationEnvelope` | built from POST body (same envelope shape) |
| `symbolSummary` | `symbolLedger.getSummary()` (client ledger) | Empty string — ledger is browser-only, missing it only lowers context freshness |
| `detectAllToolCalls` / `detectAnyToolCall` | from `tool-dispatch.ts` | Already in `lib/` — import directly |
| `sandboxToolProtocol` / `webSearchToolProtocol` | constants | Import directly |
| `verificationPolicyBlock` | `formatVerificationPolicyBlock(...)` | Re-use if lib-safe; otherwise small move down to `lib/` |
| `approvalModeBlock` | `buildApprovalModeBlock(getApprovalMode())` | Hardcode `"auto"` (pre-approved allowlist from job start) |
| `evaluateAfterModel` | `TurnPolicyRegistry` from `app/src/lib/turn-policy.ts` | **Triage required** — may import browser-only deps. Phase 1 fallback: no-op policy stub; accept minor behavior drift |

Browser-only dependencies to stub or skip:
- `fileLedger.advanceRound()` / `getAwarenessSummary()` — no-ops in DO
- `symbolLedger` — empty string
- `withActiveSpan` / `setSpanAttributes` — use the existing OTel seam or no-ops
- `getApprovalMode()` — replaced by fixed `"auto"` mode on the job
- `sandboxStatus(sandboxId)` health probe — still works; it's an HTTP call

**Shape of the extraction, not a shim duplicate.** Pull the 10-slot DI construction out of `app/src/lib/coder-agent.ts:167` into a testable builder (e.g. `lib/coder-agent-bindings.ts`) that returns `CoderAgentOptions` from a small interface of injectable services (stream fn, sandbox HTTP client, user profile). Web and DO each build their service objects and call the same builder. This is the Phase 5D shim pattern extended one level — not a parallel shim.

## 3. DO + Worker route shape

New DO class `CoderJob`, sibling to the existing `Sandbox` DO at `wrangler.jsonc:79`. Same `new_sqlite_classes` migration pattern (`wrangler.jsonc:88`) — SQLite storage is native to the runtime.

**`wrangler.jsonc` additions:**

```jsonc
"durable_objects": { "bindings": [
  { "name": "Sandbox",   "class_name": "Sandbox" },
  { "name": "CoderJob",  "class_name": "CoderJob" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Sandbox"] },
  { "tag": "v2", "new_sqlite_classes": ["CoderJob"] }
]
```

**Routes** (registered in the `EXACT_API_ROUTES` table at `app/worker.ts:231`):

- `POST /api/jobs/start` — body: `{ chatId, repoFullName, branch, sandboxId, ownerToken, envelope: DelegationEnvelope, provider, model, userProfile, verificationPolicy, declaredCapabilities }`. Returns `{ jobId }`. Worker forwards to `CoderJob.start()`. `jobId = crypto.randomUUID()`, DO id = `idFromName(jobId)`.
- `GET /api/jobs/:id/events` — SSE stream. Accept `Last-Event-ID` header for replay. Events are the existing `RunEvent` (`lib/runtime-contract.ts:372`) serialized as SSE; `event.id` is the SSE id.
- `POST /api/jobs/:id/cancel` — DO aborts via `AbortController` and persists a terminal `subagent.failed` event.
- `GET /api/jobs/:id` (optional) — status snapshot (`status`, elapsedMs, event count).

**SQLite storage in `CoderJob`:**

```sql
CREATE TABLE job (
  id TEXT PRIMARY KEY,
  chat_id TEXT, repo TEXT, branch TEXT,
  sandbox_id TEXT, owner_token TEXT,
  status TEXT,          -- queued|running|completed|failed|cancelled
  input_json TEXT,      -- envelope + provider/model/userProfile
  result_json TEXT,     -- DelegationOutcome + summary
  error_text TEXT,
  created_at INTEGER, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE,       -- RunEvent.id
  ts INTEGER,
  type TEXT, payload_json TEXT
);
```

**DO lifecycle:**

- `start()` persists input, flips to `running`, kicks off the loop via `ctx.waitUntil(this.runLoop())` so the DO outlives the request. Wall-clock cap via `storage.setAlarm()` (30 min).
- `runLoop()` calls the shared `runCoderAgent` kernel. Every lib callback (`onStatus`, `onWorkingMemoryUpdate`) and every `ToolEventEmitter` call (`lib/tool-execution-runtime.ts:57`) writes to `event` and wakes connected SSE streams via an in-memory `EventTarget`.
- `events()` on reconnect: if `Last-Event-ID` is present, resolve it to a `seq` via the `id` unique index, replay rows with `seq > <resolved>`, then attach to the live emitter. Heartbeat comment every 15s.
- `cancel()` aborts and persists a terminal event.

**Reconnect:** client resumes via `Last-Event-ID: <RunEvent.id>`; DO translates the id to its internal `seq` and replays any later rows, then live-streams. `seq` stays internal to the DO — the wire id is always `RunEvent.id`. If `status` is terminal, DO flushes the tail and closes.

## 4. Client integration (four touch points)

Guardrail: per `AGENTS.md` §New feature checklist #2, name the coordinator's home before the first line of code. It is **not** `useChat.ts`.

**Status: landed in PR #3b.**

1. **New sibling hook `app/src/hooks/useBackgroundCoderJob.ts`.** Owns: POST to `/api/jobs/start`, fetch-based SSE reader over `/api/jobs/:id/events` (tiny protocol adapter, not a general SSE client), reconnect on `visibilitychange`, dispatch into the existing `appendRunEvent(chatId, event)` sink. The server stamps each event's id + timestamp; `appendRunEvent` re-stamps for the client journal because its contract takes `RunEventInput`, and the server id is preserved separately in `pendingJobIds[jobId].lastEventId` so reconnect can send it as the `Last-Event-ID` header.
2. **Entry point.** `useAgentDelegation.ts:290` branches before calling `handleCoderDelegation`. When the global `push:background-mode-preference` flag is on AND a `backgroundCoderJob` handle was passed in, the helper `startBackgroundCoderJob` builds a `DelegationEnvelope` from the same refs the inline handler reads, POSTs it, and returns a placeholder `ToolExecutionResult`. **Locked semantic:** the placeholder says *accepted and queued*, never *started* or *completed*. The final summary never enters `apiMessages` — it surfaces through the JobCard + run timeline only, deliberately separating the chat transcript (this turn) from the run timeline (async work).
3. **JobCard.** `app/src/components/cards/JobCard.tsx` — new `coder-job` ChatCard type registered in `CardRenderer`. Shows one of `Queued | Running | Completed | Failed | Cancelled`, the elapsed timer, and the latest status line / summary / error. The `queued` placeholder text points at the card/timeline surface directly so readers don't expect the assistant thread to continue on its own.
4. **Reconnect on foreground.** Third `visibilitychange` listener lives inside `useBackgroundCoderJob.ts`; the first two (persistence flush in `useChat.ts:385-393`, run-checkpoint flush in `useChatCheckpoint.ts:302-310`) are unchanged. On foreground the hook iterates every chat's non-terminal `pendingJobIds` entries and re-opens SSE with `Last-Event-ID: <latest seen>`.

Persistence: a new `Conversation.pendingJobIds?: Record<jobId, { jobId, status, lastEventId, startedAt, updatedAt, taskPreview? }>` field flows through the existing `saveConversation` path (`conversation-store.ts` writes individual conversations to IndexedDB, so this just becomes a free addition to the next flush).

**Feature flag.** Global only in Phase 1 — `push:background-mode-preference` in localStorage, via `app/src/lib/background-mode-settings.ts`. Named as a *preference* rather than a capability flag so a later per-chat override can be layered without semantic awkwardness.

## 5. Explicitly out of Phase 1

- Push notifications (runbook Phase 4).
- Retry/backoff on provider failures (runbook Phase 3).
- Multi-tool jobs: only `delegate_coder`. No `task_graph`, no `delegate_explorer`, no `delegate_deep_reviewer`.
- Auditor integration in background context. `handleCoderAuditor` (`useAgentDelegation.ts:324`) stays foreground. Background job returns raw Coder outcome; client runs Auditor on reconnect, or skip auditor for background jobs in Phase 1.
- Cancellation guarantees under network partition — best-effort only. Wall-clock alarm is the backstop.
- Per-user KV keying of `SANDBOX_TOKENS` (already deferred per `wrangler.jsonc:43`).
- Interactive `onCheckpoint` prompts. Background runs with the callback undefined; `MAX_CHECKPOINTS=3` simply never fires.
- Job history / filters / auto-open diff on completion.

## 6. Codebase-specific risks

- **Orchestrator turn stays client-side.** Phase 1 only moves the Coder sub-loop. This is fine: the background trigger is "approved coder delegation" — the envelope is already fully materialized by `handleCoderDelegation`'s context builder.
- **Provider/model serialization.** `getActiveProvider()` + `getModelForRole(provider, 'coder')` (`app/src/lib/orchestrator.ts`, `app/src/lib/providers.ts`) are browser-only (localStorage). POST body carries `{ provider, model }` as strings; DO re-binds server-side. Verify `getProviderStreamFn` semantics are reproducible from the Worker — the `/api/<provider>/chat` endpoints already exist, so the DO can call them via internal fetch.
- **Turn-policy registry is Web-side.** `app/src/lib/turn-policy.ts` and `turn-policies/coder-policy.ts` live under `app/src/lib/`, not `lib/`. If they pull browser deps, Phase 1 either (a) moves `coder-policy.ts` down to `lib/` if already pure, or (b) stubs `evaluateAfterModel` as a no-op and accepts minor behavior drift. 20-minute triage task.
- **`SANDBOX_TOKENS` KV from DO context.** Declared at Worker level (`wrangler.jsonc:55`); DOs access bindings via `env`. Works fine. Client passes owner token in `/api/jobs/start`; DO stores and re-sends on each sandbox call.
- **`PUSH_SANDBOX_PROVIDER` dispatch from DO.** Plain `vars` (`wrangler.jsonc:22`), available on `env` everywhere. Phase 1: DO calls `/api/sandbox-cf/*` over HTTP (zero risk of divergence from the client path). Optimization to direct DO-to-DO binding call is deferred.
- **Sandbox lifetime vs job lifetime.** Foreground branch transitions now preserve the sandbox, but they still mutate the branch context under any running background job. Phase 1 mitigation: reject `/api/jobs/start` if `repoFullName + branch` don't match a live sandbox; if the foreground branch changes while a job is running, prompt "cancel running job?" or let the next sandbox call record the mismatch/failure. Background jobs may create branches for observability, but they do not fire foreground chat-routing side effects.
- **Event schema drift.** Per `AGENTS.md` §New feature checklist #3 — reuse `RunEventInput` from `lib/runtime-contract.ts:255` verbatim for the SSE payload; add a drift test in the style of `cli/tests/protocol-drift.test.mjs` pinning the DO's event output to the shared schema. Do not invent a parallel `JobEvent` type.

## Critical files

| File | Role |
|---|---|
| `lib/coder-agent.ts` | Headless kernel — already shared; the loop at `:1257` runs unchanged |
| `app/src/lib/coder-agent.ts` | DI wiring template — extract to a shareable `lib/coder-agent-bindings.ts` |
| `app/worker.ts` | Add `/api/jobs/*` routes to `EXACT_API_ROUTES` at `:231` |
| `wrangler.jsonc` | Add `CoderJob` DO binding + v2 migration |
| `app/src/hooks/useAgentDelegation.ts` | Branch point at `:290` — one-line switch to `useBackgroundCoderJob` |
| `app/src/hooks/useBackgroundCoderJob.ts` (new) | Owning module for background-job lifecycle + SSE |

## Acceptance criteria

- Start a background Coder task from chat.
- Lock phone / background the tab for ≥5 minutes.
- Reopen app: job card reflects correct status, SSE replays missed events by `Last-Event-ID`, and the final assistant summary appears in chat.
- `POST /api/jobs/:id/cancel` from UI stops execution and records a terminal event.
- Drift test pins the DO's event output to `RunEventInput` from `lib/runtime-contract.ts`.

## Suggested PR sequence

1. ✅ **Landed as #358.** Extract DI wiring to `lib/coder-agent-bindings.ts`; Web shim rebuilds on top of it. No behavior change. Tests: existing coder-agent tests stay green.
2. ✅ **Landed as #359 + #360.** Add `CoderJob` DO + wrangler migration + `POST /api/jobs/start` + `GET /api/jobs/:id/events` (SSE) + `POST /api/jobs/:id/cancel`. Server-side only; no UI wiring yet. Tests: DO integration test runs a canned envelope end-to-end.
3. ✅ **Landed as #3b.** Add `useBackgroundCoderJob` hook + JobCard + delegation-handler branch point + visibilitychange reconnect. Feature-flagged behind a global toggle (per-chat deferred).
4. Drift test + schema pin + docs update.
