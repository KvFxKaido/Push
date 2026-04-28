# AgentJob Foundation

Date: 2026-04-27
Status: **shipped** (PRs #433, #434, #435)
Owner: Push

This is the next chapter after `Background Coder Tasks Phase 1.md`. Phase 1 moved
the `delegate_coder` sub-loop server-side into the `CoderJob` Durable Object.
This arc moves **main-chat user turns** server-side through the same DO, behind
the existing global `push:background-mode-preference` flag.

The user-facing payoff: lock the phone mid-turn and the model keeps going. On
unlock the writer tab reattaches via SSE replay and sees the run in progress or
completed. Multi-turn continuity is preserved server-side via a chain of prior
job summaries.

## Goal

Validate server-owned execution for the most common chat shape (Coder runs)
without expanding the migration blast radius — no DO rename, no kernel rewrite,
no server-side chat-history store. The CoderJob class name is preserved; only
its contract gains role-awareness and chat-reference handles.

Non-goals throughout this arc: token-level streaming events, cancel/steer for
the writer tab, per-chat toggle, attachment handoff, CoderJob → AgentJob
rename, prior file-diff reconstruction. All carried as next-steps below.

## What shipped

Three PRs, each with a tight three-piece commit structure:

### PR #433 — role-aware AgentJob contract

`feat(coder)`. Generalizes the wire contract so the Coder DO can dispatch on
role without baking Coder assumptions into the boundary. No DO/file/binding
rename.

- New `RunEventInput` variants in `lib/runtime-contract.ts`: `job.started`,
  `job.completed`, `job.failed` — each carrying `role: AgentRole`. Distinct
  from the foreground-delegation `subagent.*` family; the two layers describe
  runs at different scopes.
- `CoderJobStartInput` gains `role: 'coder'` discriminator.
- `runLoop` splits into a role-agnostic outer + `executeJob` dispatcher +
  role-specific `executeCoderJob`. Adding a new role in a future PR is a
  one-line case + a new private method, not a runLoop rewrite.
- `UnsupportedRoleError` flows back as `job.failed` with the role string for
  legible client errors.
- Defense-in-depth role guards at both the worker route layer and `handleStart`,
  with `MISSING_FIELDS` vs `UNSUPPORTED_ROLE` distinguished.
- Backward-compat shims (since reverted):
  - Hook falls `subagent.*` cases through to `job.*` handler bodies for the
    in-flight DO crossing window.
  - Route layer defaults missing role to `'coder'` for cached service-worker
    bundles posting old-shape bodies.

### PR #434 — main-chat branch in `sendMessage`

`feat(chat)`. When the global `push:background-mode-preference` flag is on,
main-chat user turns route through the CoderJob DO instead of the in-browser
loop. Foreground path is byte-identical when the flag is off.

- `ChatRef` interface added to `CoderJobStartInput`:
  `{ chatId; repoFullName; branch; checkpointId? }`. Persisted via input_json
  in the DO. Wire-shape only in PR 2; PR 3 wires the loader.
- `useBackgroundCoderJob` gains `startMainChatJob` — same plumbing as the
  delegation path, but the JobCard renders onto a fresh assistant message
  (main chat has no in-progress tool-call message to attach to).
- New module `app/src/hooks/chat-send-background.ts` owns the bg-mode entry
  path: envelope construction + sandbox/repo/branch precondition checks +
  handoff. `sendMessage` in `useChat.ts` gets two surgical insertions: a bg
  writer/viewer lock at entry (silent reject when a job is in flight) and a
  branch after `prepareSendContext` that hands off to the helper.
- `prepareSendContext` gains `skipStreamingPlaceholder?: boolean` — without
  it, the foreground flow's streaming-assistant placeholder would shadow the
  JobCard and `isStreaming` would never reset. (Found in PR review.)
- Bg branch falls through to foreground when the user sends with
  attachments — main-chat envelope plumbing for attachments is deferred.

### PR #435 — chatRef context-loader

`feat(coder)`. Closes the multi-turn-continuity gap by walking
`chatRef.checkpointId` hop-by-hop and prepending up to 3 prior turn summaries
to the kernel's `taskPreamble`.

- New module `app/src/worker/agent-job-context-loader.ts`:
  - `ContextLoader` interface with a single `loadPriorTurns` method —
    deliberately narrow so PR 4+ can swap in a typed-memory query.
  - `createWebContextLoader` walks the chain via `env.CoderJob.idFromName(jobId)`
    cross-DO fetches against a new `/turn-summary` route. Hard-capped at
    `MAX_PRIOR_TURNS = 3`. Loop detection, missing-binding fallback, and
    fetch-failure degradation built in.
  - `formatPriorTurnsPreamble` produces a structured (not free-form) block so
    the kernel's context budget can model the size precisely and so PR 4's
    typed-memory replacement can produce a drop-in alternative shape.
- `CoderJob` DO gains a private `/turn-summary` route returning
  `{ jobId; chatId; status; task; summary; finishedAt; priorCheckpointId }`
  for any persisted job. Internal-only — not exposed via `worker-coder-job.ts`.
- `executeCoderJob` calls `loadPriorTurns` before building `taskPreamble`,
  prepends the formatted block. Fresh-chat behavior is byte-identical.
- `useBackgroundCoderJob.startMainChatJob` auto-fills
  `chatRef.checkpointId` from the latest completed `pendingJobIds` entry
  (filtered to `source: 'main-chat'`). Caller can pass an explicit
  `checkpointId` for fork-from-prior-turn semantics.
- Provenance check: loader compares `snapshot.chatId` against
  `chatRef.chatId` on each hop and stops on mismatch. Defense against forged
  or malformed checkpointIds leaking unrelated context. (Added in PR review.)
- `BackgroundJobPersistenceEntry` gains `source?: 'main-chat' | 'delegation'`
  so auto-fill can filter strictly to main-chat candidates and skip
  `delegate_coder` background delegations sharing the same map. (Added in
  PR review.)

## Key locked design choices

These were the deliberate calls made during scoping and review:

1. **Reference, not history.** The wire envelope carries a `ChatRef`
   (chatId / repo / branch / checkpoint), never a `priorMessages` array.
   "Jobs reference durable state, they don't inline chat history."
2. **Bridge to typed memory, not a second history store.** The chain-walk
   loader returns intent + outcome summaries only — no raw transcript, no
   patches. Hard cap at 3 hops bounds preamble growth and cross-DO fan-out.
3. **Client-passed checkpointId.** Each new turn explicitly carries the
   prior job's id. The server doesn't infer continuity from `chatId` alone.
4. **Single writer + multiple viewers.** Any tab with a non-terminal
   `pendingJobIds` entry blocks new sends. State persists in IndexedDB, so
   tab races and reloads converge on the same lock.
5. **Same JobCard rendering as delegation.** Server-owned main-chat turns
   render through the existing JobCard surface. Direct assistant-message
   replacement was deferred — proving the execution path mattered more than
   making it feel conversational.
6. **No DO rename.** `CoderJob` class name preserved through all three PRs
   to keep the migration blast radius small. The rename is a follow-up.

## Known gaps and next steps

### Bundled

**Bundle A — rolling-deploy cleanup.** The `subagent.*` shim in
`useBackgroundCoderJob.ts` and the route layer's missing-role-defaults-to-coder
behavior are time-based shims. Both flip from lenient to strict together
once any pre-PR-1 in-flight DOs have aged out. Symmetric test changes (delete
legacy-event test, flip missing-role test back to `MISSING_FIELDS`). Single
PR. Wait one to two weeks before flipping to give DOs time to terminate.

**Bundle B — bg-mode JobCard UX.** Cancel-from-writer-tab and
silent-reject-affordance are the same UI surface and conceptual change: make
the running state interactive. Writer tab gets a cancel button (existing
`/api/jobs/:id/cancel` endpoint); viewer tabs get a "running on another tab"
affordance with disabled input; the entry-guard's silent-reject becomes
visible. Pure UI — no DO changes. ~1–1.5 days.

### Standalone (don't bundle)

- **CoderJob → AgentJob rename.** Mechanical churn + wrangler `renamed_classes`
  v3 migration + file/binding renames. Per the parallel-tracks pattern this is
  the shape Codex handles well solo. The "system is proven" deferral criterion
  has been met.
- **Token-level streaming events.** New `job.assistant_progress` event variant
  carrying debounced accumulated text snapshots, emitted from `executeCoderJob`.
  Different risk shape than the JobCard UX work — kernel-side emission point
  matters; warrants its own review focus.
- **`role` column on the job schema.** `alarm()`'s emitted `job.failed`
  hardcodes `role: 'coder'`. Defer until a second role lands and actually
  needs the column.
- **Attachments in bg mode.** Today the bg branch falls through to foreground
  when `hasAttachments`. Either plumb attachments through the envelope or
  surface the limitation with an explicit affordance.

### Future / aspirational

- **Typed-memory loader.** The `ContextLoader` interface is designed for
  swap-in. The chain-by-prior-jobId implementation is the bridge; typed
  memory is the destination.
- **Per-chat toggle.** Currently global only. A per-chat override layered
  on top of `push:background-mode-preference` would be small.
- **Multi-tab steering / writer takeover.** Single-writer + viewer model is
  locked, but the path for a viewer tab to *take over* writing is unspecified.
- **Prior file diffs across turns.** Sandbox state carries file continuity
  today. If the sandbox dies between turns the chain summaries don't help
  reconstruct file changes.
- **Cross-DO fetch batching.** Chain walk is sequential — bounded but not
  great. Could parallelize with an "expand by N" route or cache snapshots in
  the new DO at start time.

### Non-blocking, pre-existing

Four typecheck errors in `worker-middleware.test.ts` (`JsonProxyConfig.method`
shape) — verified pre-existing on main throughout this arc. Independent.

## References

- PR #433 — role-aware AgentJob contract + `job.*` SSE events
- PR #434 — main-chat bg-mode branch through CoderJob
- PR #435 — chatRef context-loader for multi-turn continuity
- `docs/runbooks/Background Coder Tasks Phase 1.md` — original CoderJob DO
  scoping, predates this arc
- `docs/decisions/Resumable Sessions Design.md` §"Relationship to Background
  Coder Tasks" — the design hook this arc fulfills
