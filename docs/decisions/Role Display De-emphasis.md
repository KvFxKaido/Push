# Role Display De-emphasis

Date: 2026-06-01
Status: **Current**
Owner: Push

Push's runtime is an org chart of agent roles — Orchestrator, Explorer, Coder,
Reviewer, Auditor (`AgentRole` in `lib/runtime-contract.ts`). That structure is
correct *for the runtime*. It is the wrong thing to put in front of a human. A
user driving a coding session wants to know what **phase** the work is in
("Exploring", "Editing"), not which named sub-agent is currently holding the
baton. Foregrounding the org chart turns every status line into "we launched X,
then delegated to Y" — noise that reads like internal plumbing.

This decision de-emphasizes roles **in the presentation layer only**. It does
not touch the runtime. Internal role contracts, routing, capability tables,
event payloads, logs, and persisted data are unchanged — only what a human reads
changes.

## The four-layer split

The reason this is safe is that "role" already lives at four distinct layers,
and only the top one is human-facing:

1. **Runtime role** — the stable internal contract. `AgentRole`, provider
   routing, capability tables (`lib/capabilities.ts`), delegation logic, and the
   module names that encode roles (`coder-agent.ts`, `reviewer-agent.ts`, …).
   *Untouched.* This is what the system actually is.

2. **Event/log attribution** — raw role fields in run-events, delegation
   envelopes, structured logs, checkpoints, and analytics
   (`event.agent`, `payload.agent`, `source`, the `RunEventSubagent` union).
   *Untouched.* Debugging, replay, persistence, and observability all depend on
   the raw role string staying raw. De-emphasis must never reach this layer.

3. **Display vocabulary seam** — `lib/role-display.ts`. The single source of
   truth that maps an internal role to its user-facing phrasing. Everything a
   human reads about a role flows through here; nothing downstream re-spells a
   role label by hand.

4. **User-facing presentation** — the web cards/console and the CLI TUI. These
   render workflow **phases** first. A named actor appears only where
   attribution improves *trust* (see below), and even then the name comes from
   the seam, never from an inline string.

The guardrail that keeps layers 2 and 4 from blurring: internal role strings are
allowed in runtime contracts, role enums, capability tables, event payloads,
logs, persisted data, and tests that verify internal role behavior. Anything a
**user** reads must come from `lib/role-display.ts`.

## The vocabulary

| Internal role | Phase       | Name (when shown) | Foreground name? |
|---------------|-------------|-------------------|------------------|
| orchestrator  | *(none)*    | *(none)*          | no               |
| explorer      | Exploring   | *(none)*          | no               |
| coder         | Editing     | *(none)*          | no               |
| reviewer      | Reviewing   | Reviewer          | yes              |
| auditor       | Verifying   | Auditor           | yes              |

Rules encoded in the seam:

- **Phase-first by default.** Explorer and Coder read as phases ("Exploring",
  "Editing"), never as named actors.
- **The Orchestrator has no user-visible phase or name.** From the user's point
  of view it is simply "the assistant"; surfacing it as a distinct actor is the
  org-chart noise this decision removes.
- **Named attribution survives only where it is a trust signal.** Reviewer and
  Auditor keep visible names because a user genuinely benefits from knowing that
  an *independent* gate — not the same agent that wrote the code — reviewed or
  verified it. That is trust, not plumbing.
- **Unknown / missing roles fall back to neutral phase language ("Working"),**
  never to an invented actor name. The old `getSubagentLabel` default that
  surfaced "Planner" for any unrecognized subagent is gone.
- **Background Coder is a presentation context, not a role.** A background Coder
  job may carry actor attribution where the UI historically needed a standalone
  card title; that label is reached via `getRoleDisplay('coder', { background:
  true })` and lives inside the seam. No new runtime role, and no "Background
  Coder" string spelled outside the seam.
- **`RunEventSubagent` superset.** Run-event streams carry values beyond the five
  roles (`planner`, `deep_reviewer`, the structural `task_graph`). The seam maps
  them too: `planner` → "Planning" (a Coder sub-seam, shown as a phase),
  `deep_reviewer` → the Reviewer display, `task_graph` → "Task Graph" (a workflow
  construct, not an agent identity).

## Surface

- `lib/role-display.ts` — `ROLE_DISPLAY`, `RoleDisplay`, `RoleDisplayContext`,
  `getRoleDisplay(role, options?)`, `getSubagentDisplay(subagent)`,
  `getSubagentLabel(subagent)`.
- `cli/tests/role-display.test.mjs` — drift test pinning the vocabulary map, in
  keeping with CLAUDE.md's "one source of truth per vocabulary" rule.

Routed through the seam: web `HubConsoleTab`, `DelegationResultCard`,
`JobCard`, `CoderProgressCard`, `AuditVerdictCard`, `ChatContainer` resume
banner, `CommitPushSheet` phase labels, `SettingsSectionContent` Auditor gate
label; CLI `tui-spinner` delegation verbs, `tui-delegation-events`
subagent/task lifecycle lines **and the graph-snapshot renderer**
(`createDelegationTranscriptRenderer` / `taskGraphEventToTranscript`, via the
single `formatNodeAgent` chokepoint), and `pushd` read-only-role denial label.

The graph-snapshot renderer is a node-graph diagnostic that annotates *which
executor ran which node*. It still renders to a user-facing transcript, so its
executor tags now flow through the seam too — a node previously shown as
`[done] build-api (coder, 123ms)` reads as `[done] build-api (Editing, 123ms)`.
The raw role string stays on the node (`node.agent`) for any attribution use;
only the rendered label is mapped.
