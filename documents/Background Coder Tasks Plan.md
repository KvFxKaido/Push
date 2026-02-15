# Background Coder Tasks Plan

Date: 2026-02-13 (Updated: 2026-02-15)  
Status: Draft  
Owner: Push

## Goal

Allow long-running coding tasks to continue when the mobile app is backgrounded or the phone is locked, then let the user reconnect and see progress/results.

## Why this is needed

- Current orchestrator + tool loop runs in the browser client.
- Mobile browsers aggressively suspend background JS/network work.
- Result: coding sessions can stall when users switch apps or lock screen.

**2026-02-15 Research Findings:**
- Browser Background Sync API is **unsuitable** for Push's use case:
  - Service workers get killed on long tasks (coding sessions need 5-30 min)
  - iOS Safari has limited/no Background Sync support (Push is mobile-first)
  - 24-hour retention limits don't fit multi-hour sessions
  - Battery-conscious throttling aggressively kills background tasks
- **Server-side execution is the correct architecture** for long-running coding tasks
- Background Sync API should only be used for small, quick operations (e.g., commit notification queue)

## Scope (MVP)

- Add server-side background jobs for `delegate_coder` style tasks.
- Persist job state and step logs outside the browser session.
- Support reconnect/resume from any client session.
- Support explicit cancel from UI.
- Keep existing foreground behavior as fallback.

Out of scope (MVP):

- Push notifications
- Multi-tenant billing/accounting changes
- Full orchestration migration of all tools

## Proposed Architecture

### 1) Job Runtime

- Use Cloudflare Durable Objects as per-job coordinators.
- One job id = one durable execution record + event log.
- DO manages state machine and append-only timeline.

### 2) Execution Worker Path

- New Worker routes:
  - `POST /api/jobs/start`
  - `GET /api/jobs/:id`
  - `GET /api/jobs/:id/events`
  - `POST /api/jobs/:id/cancel`
- Worker validates auth/repo/branch context, then forwards to DO instance.

### 3) Sandbox + Coder Execution

- DO invokes sandbox and LLM provider calls using existing shared logic.
- Keep same coder loop semantics (unbounded rounds, per-round timeout) but in server context.
- Persist checkpoints, tool calls, errors, and summaries as events.

### 4) Client UX

- Add “Run in background” action when coder delegation is selected.
- Chat gets a job card with:
  - status (queued/running/completed/failed/cancelled)
  - elapsed time
  - latest step/status line
  - open/resume button
- On reconnect, UI streams events from `/api/jobs/:id/events` (SSE preferred over polling for battery efficiency).

**Client-side queue management (small ops only):**
- Use IndexedDB to queue small, quick actions (e.g., "commit completed" notifications)
- Use Background Sync API for retry on reconnect (not for coding tasks)
- Fallback to manual retry UI if Background Sync unsupported

## Data Model (initial)

- `jobId`
- `chatId`
- `repoFullName`
- `branch`
- `requestedBy` (user id/device id as available)
- `status`: `queued | running | completed | failed | cancelled`
- `createdAt`, `startedAt`, `finishedAt`
- `input` (task + files + selected provider/model)
- `resultSummary`
- `error`
- `events[]`:
  - `timestamp`
  - `type` (`status`, `tool_call`, `tool_result`, `checkpoint`, `log`, `error`)
  - `source` (`orchestrator`, `coder`, `auditor`, `system`)
  - `message`
  - optional `detail/meta`

## Rollout Plan

## Phase 0: Design + contract

- Finalize API contracts + job state machine.
- Define event schema and retention policy.
- Decide event transport: polling first; streaming optional later.

Exit criteria:

- API + schema doc approved.

## Phase 1: Backend MVP

- Add Durable Object + wrangler bindings/migrations.
- Implement job start/status/cancel routes.
- Implement server-side coder execution path with persisted events.

Exit criteria:

- Job survives client disconnect and can be resumed by id.

## Phase 2: Frontend integration

- Add background-run toggle/action in chat flow.
- Render job cards and status timeline.
- Reconnect logic in chat/workspace on app reopen.

Exit criteria:

- User can start job, lock phone, reopen app, and see completion.

## Phase 3: Reliability hardening

- Retry policy for transient provider/sandbox failures.
- Timeout/heartbeat detection and stuck-job recovery.
- Cancellation guarantees and cleanup hooks.

Exit criteria:

- Stable behavior under network interruption + provider failures.

## Phase 4: Nice-to-have enhancements

- Push notification on completion/failure.
- Job history screen + filters.
- Optional “auto-open diff” on completion.

## One-time Setup Required

Deployment/operator setup:

- Add Durable Object class + migration in `wrangler.jsonc`.
- Add any needed storage binding (optional KV/R2 if chosen).
- Deploy Worker with updated bindings.
- Configure auth enforcement for job endpoints.

End-user setup:

- None after deployment.

## Risks and Mitigations

- Risk: server-side execution diverges from client behavior.
  - Mitigation: share core coder/tool modules where possible.
- Risk: runaway jobs increase cost.
  - Mitigation: max wall-time, max rounds, explicit cancellation.
- Risk: stale branch/sandbox context.
  - Mitigation: persist repo+branch lock on job start and enforce at execution.
- Risk: event log growth.
  - Mitigation: event cap + compaction policy.

## Open Questions

- Should background jobs be allowed for all tools or only coder delegation initially?
- ~~Polling vs SSE for event delivery in mobile conditions?~~ **RESOLVED: SSE preferred** (battery-friendly, auto-reconnect, event replay from last-seen ID)
- What retention window for completed jobs (24h, 7d, configurable)?
- Should completed jobs auto-post a synthetic assistant summary into chat?
- Should we add native Push Notifications for job completion? (Phase 4 enhancement)

## Acceptance Criteria (Product)

- Start background coding task from chat.
- Lock/switch apps for at least 5 minutes.
- Reopen app and recover job state/progress.
- Completed job exposes summary + changed files/diff path.
- User can cancel active background job from UI.

## Implementation Patterns (from 2025-2026 PWA Research)

### Server-Side Job Architecture (Primary)
```
Mobile Client (PWA)
  ├─ Creates job request with pre-approved tool allowlist
  ├─ SSE connection for real-time progress
  └─ Auto-reconnect on wake/foreground with last event ID

Cloudflare Durable Object
  ├─ Job orchestration + state machine
  ├─ Append-only event log with replay capability
  └─ SSE stream (clients reconnect via last-seen event ID)

Modal Container (Coder Agent)
  ├─ Runs unbounded tool loops
  ├─ Checkpoints progress to DO event log
  └─ Continues execution even if client sleeps
```

### Client-Side Queue (Small Ops Only)
```
IndexedDB Queue
  ├─ Store pending actions before server submission
  ├─ Retry failed job creations on reconnect
  └─ Cache job results for offline viewing

Background Sync API (when supported)
  ├─ Queue small ops: commit notifications, like actions
  ├─ 24-hour max retention window
  └─ Fallback to manual retry UI if unsupported
```

### Key Design Decisions

**✅ DO with SSE** (not polling)
- Battery-friendly for mobile
- Auto-reconnect with event replay
- DO can buffer missed events during client sleep

**✅ Pre-approved tool allowlist at job start**
- No runtime permission prompts during background execution
- Declared in `POST /api/jobs/start` request body
- Auditor review happens before job submission, not during

**✅ Context compaction within background jobs**
- 60KB context cap per Coder round (existing safeguard)
- Checkpoint summaries to event log for reconnecting clients
- Clients reconstruct progress without replaying every tool call

**❌ Don't use Background Sync API for coding tasks**
- Service workers killed on long operations (5-30 min coding sessions)
- iOS Safari has limited/no support
- Battery/memory throttling on mobile devices

**❌ Don't rely on client-side retry hell**
- Move complexity to server-side DO orchestration
- Client only responsible for job creation and reconnection

### References
- [Microsoft: Synchronize and update a PWA in the background](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/background-syncs)
- [MDN: Offline and background operation - PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
- [Advanced PWA Playbook: Background Sync](https://rishikc.com/articles/advanced-pwa-features-offline-push-background-sync/)
- [OneUptime: Background Sync in React PWAs (Jan 2026)](https://oneuptime.com/blog/post/2026-01-15-background-sync-react-pwa/view)
