# Workspace State Events — Snapshot + Delta

Date: 2026-07-05
Status: **Draft** — shared vocabulary, builders, reducer, strict wire validators, the git→state mapper, and the **web producer adapter** (`useWorkspaceSandboxController.ts`) have landed on `claude/copilotkit-research-8bblb4` with unit + hook-level tests. Not yet walked end-to-end in the live app (no consumer renders the view yet), and the CLI daemon emitter is still staged — see "What landed vs. staged wiring". Flip to **Current** once the view is consumed in-app and walked once. Owner: Push web/runtime.

Related: [`Repo-Scoped Chats — Branch as Session State.md`](<Repo-Scoped Chats — Branch as Session State.md>) (the mutable-branch-as-session-state model these events serialize); the branch-desync guard in `app/src/hooks/useWorkspaceSandboxController.ts` (the sandbox-lifecycle signal that drives snapshots).

Prompted by a look at CopilotKit / the AG-UI protocol, whose `STATE_SNAPSHOT` + `STATE_DELTA` (JSON Patch) event pair is the one idea there Push didn't already own.

## Motivation

Push already streams a rich *lifecycle* event log (`lib/run-events.ts`: `tool.execution_start`, `subagent.started`, `branch_desync`, …). What it did **not** have is a first-class carrier for *live workspace state* — the active branch, HEAD, dirty working tree, and the guards (Protect Main, sandbox readiness) that gate delivery. Today each surface reconstructs that from `BranchSwitchPayload` moments plus ad hoc HEAD polling. Two shells, two reconstructions, no single diffable timeline — exactly the "one source of truth per vocabulary" gap the new-feature checklist in `CLAUDE.md` warns about.

## Decision

Add a snapshot + delta event pair, modeled on AG-UI but adapted to Push's constraints:

- **`workspace.state_snapshot`** — full authoritative `WorkspaceState`. Ground truth; a consumer adopts it unconditionally.
- **`workspace.state_delta`** — a patch against a prior snapshot, carrying a **closed op-set** (`set_branch`, `set_head`, `set_tracking`, `dirty_add`, `dirty_remove`, `dirty_clear`, `set_protect_main`, `set_sandbox_ready`).

Three deliberate divergences from CopilotKit / AG-UI:

1. **Constrained delta, not raw RFC-6902 JSON Patch.** Arbitrary JSON Pointer ops can't be strict-validated, and open-ended patches violate "keep it declarative, never open-ended." Every op names a known field, so `lib/protocol-schema.ts` validates the whole wire. Unknown ops fail strict mode at emit time; the reducer stays total (skips them) so an additive op from a newer emitter degrades to a no-op instead of throwing in a render path.

2. **`rev` scoped to a `workspaceId`, not global.** A delta applies **only** when both the consumer's `workspaceId` matches AND its last-applied `rev === delta.baseRev`. `rev` is monotonic *within* a `workspaceId`; a new identity (sandbox restart, different repo) starts a fresh timeline at rev 0 via `reset`. This is what keeps the timeline correct across the desync-guard sandbox restarts.

3. **Resync-via-snapshot, because Push events are trimmed + replayed.** AG-UI assumes a guaranteed-ordered stream; Push trims at `MAX_RUN_EVENTS_PER_CHAT = 400` and replays on reconnect. So a delta must be droppable: on any base mismatch the consumer keeps its current view and waits for the next snapshot. The producer sends a snapshot (not a delta) on sandbox start, resume, reconnect, and whenever it can't prove the client's `rev`.

### The reducer contract (behavior, not just shape)

`reduceWorkspaceStateEvent(view, event)` in `lib/workspace-state.ts` returns one of five outcomes, each a distinct logged branch (symmetric structured logs, `console.error` because this module also runs on the CLI):

| Outcome | When | View |
|---|---|---|
| `snapshot_adopted` | any snapshot | replaced |
| `delta_applied` | `workspaceId` match ∧ `rev === baseRev` | advanced |
| `delta_dropped_no_base` | delta with no prior snapshot | unchanged (null) |
| `delta_dropped_identity` | `workspaceId` mismatch | unchanged |
| `delta_dropped_gap` | `rev !== baseRev` (a delta was lost) | unchanged |

A dropped delta is never applied onto a mismatched base — that is precisely the failure mode (a UI showing a branch the sandbox already left) the whole design exists to prevent.

## Explicitly kept separate: `session_state_changed`

`session_state_changed` already carries **settings / session config** (provider, model, role routing) as a full snapshot. It is **not** merged into this vocabulary and must not be. Config state and live workspace state change on different clocks, have different consumers, and would make "session state" too broad to reason about. The split is load-bearing; keep two narrow vocabularies over one wide one.

## What landed vs. staged wiring

**Landed:**
- Types + two `RunEventInput` union members — `lib/runtime-contract.ts`.
- Builders + reducer + git→state mapper (pure, framework-agnostic) — `lib/workspace-state.ts`.
- Strict wire validators + registry — `lib/protocol-schema.ts`.
- Parallel published JSON Schema + regenerated artifact — `lib/protocol-json-schema.ts`, `schema/`.
- Schema-drift pins — `cli/tests/protocol-drift.test.mjs`, `cli/tests/protocol-json-schema.test.mjs`.
- Reducer / gap-behavior / mapper tests — `cli/tests/workspace-state.test.mjs`.
- **Web producer adapter** — `useWorkspaceSandboxController.ts`. It holds a `createWorkspaceStateProducer` keyed by `sandboxId` (the workspace identity) and drives it off the same git-status reads that feed the status card: a new sandboxId → snapshot (fresh `createWorkspaceStateProducer`), same id → minimal `update` delta, `idle` / session-change → producer + view reset. HEAD sha (absent from the status payload) is fetched via the git backend, with a stable placeholder on an unborn branch. Each event is reduced through `reduceWorkspaceStateEvent` into an exposed `workspaceStateView` and forwarded to an optional `onWorkspaceStateEvent` sink. Covered by hook-level tests (snapshot-then-delta, reduced-view exposure).

**Staged (next increments):**
- **Consumer.** Nothing renders `workspaceStateView` or forwards `onWorkspaceStateEvent` onto the run-event stream yet — the adapter produces into a currently-unwired sink. Wiring a branch/dirty UI consumer (and/or the run-event forward) is what earns the **Current** flip.
- **Real `Protect Main`.** The adapter takes `protectMain` as an optional arg defaulting to the product's off-by-default state; thread the live setting from `WorkspaceSessionScreen` when the consumer lands.
- **CLI daemon emitter.** `cli/pushd.ts` emits the same vocabulary from real filesystem/HEAD signals, reusing `gitStatusInfoToWorkspaceState` + `createWorkspaceStateProducer` verbatim — no React-shaped assumptions cross over, because none live in `lib/workspace-state.ts`.
