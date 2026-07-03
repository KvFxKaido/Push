/**
 * Daemon protocol capability vocabulary — single source of truth.
 *
 * These are the pushd *protocol feature flags* advertised in the `hello`
 * handshake and negotiated back by clients in `attach_session` — a SEPARATE
 * vocabulary from the tool/role permission `Capability` in `lib/capabilities.ts`
 * (`repo:read`, `git:push`, …). Don't conflate them: these gate wire-protocol
 * behaviour (event shape, replay, snapshot), not what a run is allowed to do.
 *
 * Why this module exists: the daemon advertises the full set; clients advertise
 * the subset they understand. Before centralization these strings were bare
 * literals duplicated across `cli/pushd.ts`, `cli/tui.ts`, and `cli/cli.ts`, so
 * a rename on one side could silently desync client-advertised from
 * server-supported (the "one source of truth per vocabulary" guardrail in
 * AGENTS.md). Now the daemon set lives here, client profiles are typed against
 * it (a typo or a non-existent capability is a compile error), and the drift
 * test in `cli/tests/daemon-integration.test.mjs` pins the vocabulary and the
 * subset relationships. See GitHub #745.
 *
 * Negotiation stays forward-compatible: a client advertising a capability the
 * daemon lacks is ignored, and an RPC the daemon doesn't implement returns
 * `UNSUPPORTED_REQUEST_TYPE`, so a mismatch degrades cleanly rather than
 * breaking.
 */

/**
 * The full capability set the daemon advertises in `hello`. Order is the wire
 * order; the drift test pins it so removals/renames are deliberate, visible
 * changes rather than silent edits.
 */
export const DAEMON_CAPABILITIES = [
  'stream_tokens',
  'approvals',
  'replay_attach',
  'session_snapshot_v1',
  'multi_client',
  'crash_recovery',
  'role_routing',
  // `runtime_config_v1`: paired clients can read and update daemon-owned
  // runtime preferences (`PUSH_EXEC_MODE` / `PUSH_WEB_SEARCH_BACKEND`) through
  // explicit RPCs instead of rendering local no-op controls.
  'runtime_config_v1',
  'delegation_explorer_v1',
  'delegation_reviewer_v1',
  // `delegation_deep_reviewer_v1`: `delegate_deep_reviewer` RPC runs the
  // multi-round investigation kernel (`runDeepReviewer`) with a REAL read-only
  // CLI-native tool loop (`makeDaemonExplorerToolExec({ role: 'reviewer' })` +
  // `wrapCliDetect*` + `READ_ONLY_TOOL_PROTOCOL`). The reviewer reads
  // surrounding code/callers/tests before forming its opinion, then returns the
  // same `ReviewResult` as the simple reviewer.
  'delegation_deep_reviewer_v1',
  // `delegation_coder_v1`: `delegate_coder` RPC + task-graph coder nodes
  // run through `runCoderAgent` with a REAL daemon tool executor
  // (`makeDaemonCoderToolExec`) that routes through `executeToolCall`
  // from `cli/tools.ts` with approval gating via `buildApprovalFn`.
  // Coder delegations actually read/write files and run shell commands
  // under approval gating; outcomes land as `'complete'` on clean
  // kernel returns.
  'delegation_coder_v1',
  // v2 task-graph execution: submit_task_graph accepts graphs, runs
  // them through lib/task-graph.executeTaskGraph, and streams
  // task_graph.* events. Both `agent: 'coder'` and `agent: 'explorer'`
  // nodes route through their respective real daemon tool executors
  // (see `delegation_coder_v1` above and `multi_agent` below).
  'task_graph_v1',
  // `event_v2`: the daemon emits raw `subagent.*` / `task_graph.*` envelopes
  // to clients that advertise this cap back in `attach_session.capabilities`.
  // Clients that omit the cap (including v1 clients that don't know to send
  // it) receive synthesized `assistant_token` events on the parent runId
  // instead — see `cli/v1-downgrade.ts` and the "v1 Client Handling —
  // Option C" section of `docs/decisions/push-runtime-v2.md`.
  'event_v2',
  // `multi_agent`: both Explorer and Coder daemon-side tool executors
  // are wired to real production tool surfaces (`executeToolCall` from
  // `cli/tools.ts`). Explorer runs `makeDaemonExplorerToolExec` with
  // `roleCanUseTool('explorer', ...)` enforcement against the shared
  // capability table (`lib/capabilities.ts`) and no approval gating;
  // Coder runs `makeDaemonCoderToolExec` with full tool surface +
  // approval gating (Coder capability gate is deferred per Gap 2
  // rollout phasing — needs its own grant audit).
  // Delegation outcomes land as `'complete'` for both agents on clean
  // kernel returns — the daemon can host end-to-end multi-agent flows
  // (direct delegation RPCs + dependency-ordered task graphs).
  // Reviewer stays single-turn JSON-only by design.
  'multi_agent',
] as const;

/** A capability the daemon advertises. */
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

/**
 * `event_v2` as a named constant for the branching `capabilities.has(...)`
 * checks in `cli/pushd.ts` (raw-vs-synthesized event routing). Referencing the
 * const instead of a bare string keeps those checks renamed in lockstep with
 * the advertised vocabulary.
 */
export const EVENT_V2: DaemonCapability = 'event_v2';

/** True if `value` is a capability the daemon advertises. */
export function isDaemonCapability(value: unknown): value is DaemonCapability {
  return typeof value === 'string' && (DAEMON_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Capabilities the full-screen TUI client advertises back to the daemon. It
 * consumes raw v2 events (`event_v2`) and the reconnect status packet
 * (`session_snapshot_v1`). Typed against {@link DaemonCapability} so an entry
 * the daemon doesn't advertise fails typecheck.
 */
export const TUI_DAEMON_CAPABILITIES = Object.freeze([
  'event_v2',
  'session_snapshot_v1',
] satisfies DaemonCapability[]);

/**
 * Capabilities the headless attach client (`push attach` / CLI engine path)
 * advertises. It opts into raw v2 events only.
 */
export const ATTACH_CLIENT_CAPABILITIES = Object.freeze(['event_v2'] satisfies DaemonCapability[]);
