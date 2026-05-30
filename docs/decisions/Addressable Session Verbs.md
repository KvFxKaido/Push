# Addressable Session Verbs

Date: 2026-05-30
Status: **Draft, ROADMAP-tracked** (Session Continuity & Stability) — vocabulary
pinned; phased implementation. This is suggested-priority #2 from
[`opencode SDK Review.md`](opencode%20SDK%20Review.md), unblocked now that the
[`Universal Session Bearer`](Universal%20Session%20Bearer.md) shipped.
Owner: Push

Pin **one canonical spelling** for the session-lifecycle verbs Push already
performs internally — `abort` / `revert` / `summarize` / `children` and friends —
so a future session API (or a third surface) never invents a third name for the
same operation. The bearer made every session authenticated *by construction*;
this layer is the verb vocabulary that sits on top of it. The sequence is
**bearer → addressable verbs → optional session API**, not three unrelated
efforts.

## Decision

Three forks, decided (2026-05-30):

1. **Deliverable = doc + thin executable aliases**, not doc-only. Where a verb
   maps to an operation that is *genuinely* reachable from the daemon today, ship
   it as a real, bearer-gated daemon verb that delegates to the existing handler.
   Where it does not, pin the name in this doc and sequence the real build as its
   own phase. **An audit (below) found most "aliases" are not actually thin** —
   only `abort` is, and it sits on an un-gated handler. So the executable surface
   lands incrementally, not in one sweep; this doc is the contract those phases
   conform to.

2. **Hybrid naming.** Where Push already ships a handler, *its* name stays
   canonical (`cancel_run`, `update_session`, `send_user_message`, …) and the
   opencode spelling is recorded as the equivalent. Genuinely-new addressable
   verbs that Push only does *internally* take opencode-aligned names in Push's
   snake_case house style (`session_revert`, `session_summarize`, `list_children`).
   No churn on working handlers; one spelling per concept.

3. **Children are modeled as addressable child sessions.** A delegated
   Coder/Explorer/Reviewer run becomes an addressable thing (an id you can list,
   read, attach to, and abort), not an opaque `DelegationOutcome` payload. The
   audit found the daemon is already ~80% of the way there (stable subagent ids,
   per-child run ids, event filtering by child run id) — this formalizes the
   addressing rather than inventing it.

## The verb vocabulary (canonical)

The centerpiece. `canonical` is the name Push uses; `opencode` is the equivalent
in the reference SDK; `backs onto` is the existing machinery; `status` is where
it stands after the audit.

| Concept | Canonical (Push) | opencode | Backs onto | Status |
|---|---|---|---|---|
| Create | `start_session` | `session.new` / `init` | `handleStartSession` | shipped |
| List | `list_sessions` | `session.list` | `handleListSessions` | shipped |
| Read transcript | `get_session_messages` | `session.get` / messages | `handleGetSessionMessages` | shipped |
| Prompt | `send_user_message` | `session.prompt` | `handleSendUserMessage` | shipped |
| Update | `update_session` | `session.update` | `handleUpdateSession` | shipped |
| **Abort (parent run)** | `cancel_run` | `session.abort` | `handleCancelRun` | shipped — **auth gap, see below** |
| **Abort (child run)** | `cancel_delegation` | child `session.abort` | `handleCancelDelegation` | shipped |
| Permission respond | `submit_approval` | `permissions/{id}/respond` | `handleSubmitApproval` + `approval_*` events | shipped (Push is *ahead* — already a request/respond pair) |
| **Children — list** | `list_children` | `session.children` | `activeDelegations` map + `state.delegationOutcomes` | **phase: children** |
| **Children — read** | `get_child_session` | child `session.get` | filter parent log by `childRunId` (`fetch_delegation_events`) | **phase: children** |
| **Children — attach** | `attach_child_session` | (n/a) | broadcast child events by `childRunId` | **phase: children** |
| **Summarize** | `session_summarize` | `session.summarize` | compaction (`compactContext`, CLI-only today) | **phase: summarize** |
| **Revert / unrevert** | `session_revert` / `session_unrevert` | `session.revert` / `unrevert` | *none daemon-reachable* | **phase: revert (real build)** |
| Abort verb sugar | `abort` (alias) | `session.abort` | routes to `cancel_run` / `cancel_delegation` by id shape | **phase: abort (after the gap fix)** |

Names recorded but **out of scope** (no Push equivalent, or a deliberate
divergence): `share` / `unshare` (Push relay pairing is device-level, not
session-level sharing), `shell` / `command` (Push runs these as `sandbox_exec` /
tool calls, not session verbs), `delete` (`deleteSession` exists in
`cli/session-store.ts` but has no daemon verb — pin `delete_session` for the day
one is wanted).

## Current state (audit, 2026-05-30)

Daemon verbs today (`HANDLERS` in `cli/pushd.ts`): `hello`, `ping`,
`list_sessions`, `start_session`, `send_user_message`, `attach_session`,
`get_session_messages`, `update_session`, `submit_approval`, `cancel_run`,
`configure_role_routing`, `submit_task_graph`, `delegate_{explorer,coder,reviewer,deep_reviewer}`,
`cancel_delegation`, `fetch_delegation_events`, `sandbox_*`, device/relay admin.

### Feasibility findings — the "thin alias" reality check

The premise that the pinned verbs are thin wrappers over reachable machinery
**did not survive the audit**. Per verb:

- **`abort` — thin, but the target has an auth gap.** `cancel_run` (parent) and
  `cancel_delegation` (child) are cleanly separated and both reachable, so an
  `abort` verb that routes by id shape is genuinely thin. **However**
  `handleCancelRun`'s session-ful path (`cli/pushd.ts:~1856`) aborts a run from
  `sessionId` alone with **no `validateAttachToken`** — it was not among the
  bearer's 11 enforcement sites. A relay-authenticated client could cancel a run
  on a session it doesn't hold the bearer for. (The local unix socket is 0600 and
  the runId-only path is WS-connection-scoped, so the blast radius is a paired
  remote client cancelling another session's run — modest, but a real
  cross-session authz gap, and exactly the "attach is uniformly authenticated"
  invariant the bearer set.) **Formalizing `abort` as a public verb must not
  spread this** — close the gap first.

- **`session_summarize` — not thin.** On-demand compaction (`compactSessionContext`
  → `compactContext`) lives in the CLI REPL (`cli/cli.ts:~885`), **not in `lib/`**,
  so it is not daemon-reachable. Automatic compaction *is* reachable (the
  `manageContext` callback in `cli/engine.ts` trims on every round), but there is
  no on-demand entry point. Thin-ness requires first promoting `compactContext`
  into `lib/`.

- **`session_revert` — a real build, not a wrapper.** There is **no**
  daemon-reachable rollback. Coder checkpoint/resume is web-Durable-Object-only
  (`app/src/worker/coder-job-do.ts`); git-level revert only reachable indirectly
  via `delegate_coder`; `rewriteMessagesLog` (`cli/session-store.ts`) can rewrite
  the message log but there is no checkpoint/marker index to *find* a revert
  target. A real `session_revert` needs a run-scoped checkpoint marker + a
  message-log truncate handler. Heaviest phase; may warrant its own mini-design.

- **`children` — ~80% there.** Delegated runs already mint stable ids
  (`sub_explorer_*` / `sub_coder_*`) paired with a `childRunId`, tracked in the
  in-memory `entry.activeDelegations` map, with parent linkage (`parentRunId`)
  and event filtering already wired (`handleFetchDelegationEvents` filters by
  `childRunId`). Missing 20%: a verb to *list* them and formal child addressing.
  No new disk format needed — a child run is a filtered view of the parent log.

## Design

### Children as child sessions

A delegated run is addressed by its existing `subagentId` (the stable, minted id).
It does **not** get its own `state.json`; it is a *view* over the parent session:

- `list_children(sessionId)` → active delegations (`activeDelegations` keys +
  role/task/startedAt) plus completed `state.delegationOutcomes`. Read-only,
  bearer-gated.
- `get_child_session(sessionId, subagentId)` → the child's transcript,
  reconstructed by filtering the parent message/event log on `childRunId` (reuse
  the `fetch_delegation_events` filter).
- `attach_child_session(sessionId, subagentId)` → live child events, scoped by
  `childRunId`.
- Child abort = `cancel_delegation(sessionId, subagentId)` (already shipped).

This keeps the branch-as-session-target model intact (children are sub-views, not
peers) and reuses every existing seam. Bearer enforcement is inherited: all child
verbs validate the **parent** session's attach token.

### The `abort` sugar verb

Once the `cancel_run` gap is closed, register `abort` as a bearer-gated alias that
routes by id shape: a `subagentId` (`sub_*`) → `cancel_delegation`; otherwise →
`cancel_run`. Thin, and correct because both targets are then uniformly gated.

## Symmetric logs

- `child_session_listed` / `child_session_attached` (info) on the children verbs.
- `cancel_run_unauthenticated_rejected` (warn) once the gap is closed — pairs with
  the existing accept path so the new rejection is visible to ops.

## Implementation sequence (phased)

Each phase re-verifies the vocabulary table and ships its drift test in-PR, per
the AGENTS.md "one source of truth per vocabulary + drift-detector" rule.

1. **This doc** — pin the vocabulary; record the audit + the `cancel_run` gap.
2. **`cancel_run` auth gap + `abort` verb.** Gate `handleCancelRun`'s session-ful
   path with `validateAttachToken` (making it the 12th enforcement site); update
   the two session-ful callers to send the bearer — TUI (`cli/tui.ts:~3015`) and
   web pending-approval cancel (`app/src/lib/daemon-cancel-pending-approvals.ts:~85`);
   then register the `abort` alias. Ship the lockout/auth tests in-PR.
3. **Children.** `list_children` → `get_child_session` → `attach_child_session`,
   reusing the delegation seams. Read verbs first (safe, additive).
4. **`session_summarize`.** Promote `compactContext` to `lib/`; add the on-demand
   verb emitting `context_compacted`.
5. **`session_revert`.** Run-scoped checkpoint marker + message-log truncate.
   Its own mini-design first.

## Out of scope

- A session **REST API** / published OpenAPI for these verbs — that is the layer
  *above* this (opencode review suggested-priority #3), deferred until a consumer
  forces it. This doc pins the vocabulary the API would expose; it does not build
  the API.
- The opencode **parts model** (typed `ToolState*` message parts) — heaviest
  borrow, chase only if resumable-sessions growth forces it.
- opencode's **headless-server topology** and **`share`/`shell`/`command`** verbs
  — explicit non-borrows (see the opencode review's "What's Not Worth Borrowing").

## Graduation

ROADMAP-tracked under **Session Continuity & Stability** (track follow-on to the
bearer). Flip `Status:` to Current when phases 2–5 land; until then this doc is
the contract each phase conforms to.
