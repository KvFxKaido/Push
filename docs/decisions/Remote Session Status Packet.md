# Remote Session Status Packet

Date: 2026-05-31
Status: **Current** — Slice 1 daemon contract shipped; client hydration follows
Owner: Push

Push remote sessions should feel stable because every client is a view onto
daemon-owned truth, not because each surface gets better at guessing from local
state and partial event replay. This doc defines the shared status packet that
TUI, mobile, and future remote surfaces can hydrate from on connect/reconnect.

## Decision

Add a bearer-gated daemon read RPC, `get_session_snapshot`, that composes
existing daemon truth into one coherent packet:

- host identity and daemon version
- repo root and branch
- relay persisted/live state
- session provider/model/state/role routing/event cursor
- active parent run, if any
- pending approval, if any
- recent event tail for UI hydration/debug context

The packet is read-only. It must not create session state, mint tokens, mutate
approval state, or expose bearer plaintext. It is the reconnect baseline; event
replay remains the mechanism for precise transcript deltas.

## Slice 1 — shipped 2026-05-31

The daemon contract ships first:

1. `get_session_snapshot` accepts `{ sessionId, attachToken, recentEventLimit? }`.
2. It lazy-loads the session like `get_session_messages` / `list_children`.
3. It validates the session attach token.
4. It returns the minimum stable packet needed for clients to render "what is
   happening now" immediately after reconnect.

Out of scope for Slice 1:

- terminal tails
- diff summaries
- validation/check history
- mobile/TUI UI rewrites
- durable run metadata beyond `activeRunId`

Those fields can be added once the base contract is in use.

## Target Shape

```ts
{
  host: {
    hostname: string;
    daemonVersion: string;
    protocolVersion: string;
    startedAtMs: number;
  };
  repo: {
    rootPath: string;
    branch: string | null;
  };
  relay: {
    persisted: { deploymentUrl: string; enabledAt: number | null } | null;
    live: object;
  };
  session: {
    sessionId: string;
    // 'running' whenever a foreground run (activeRunId) OR background work
    // (delegations / task graphs) is in flight — mirrors handleUpdateSession's
    // RUN_IN_PROGRESS gate, which also blocks on the runtime maps. Background
    // delegation clears activeRunId but is still live work, so keying state on
    // activeRunId alone would mis-report 'idle' to a reconnecting client.
    state: 'idle' | 'running';
    activeRunId: string | null;
    // Counts of in-flight sub-agent work that has no top-level run id. Lets a
    // client distinguish foreground (activeRun set) from background running.
    backgroundWork: { delegations: number; graphs: number };
    provider: string;
    model: string;
    mode: string;
    roleRouting: object;
    eventSeq: number;
    attachTokenPresent: boolean;
  };
  // Foreground run descriptor. type/cancellable are fixed to the assistant-turn
  // model activeRunId represents today; when a delegation/task graph is the
  // in-flight work, activeRunId is null (see session.backgroundWork) so this is
  // null rather than describing a child run with different cancel semantics.
  // Widen when the run model grows cancellable child descriptors.
  activeRun: {
    runId: string;
    type: 'assistant_turn';
    cancellable: true;
  } | null;
  pendingApproval: {
    approvalId: string;
    runId: string | null;
    // Display context mirroring the live `approval_required` event so a client
    // that reconnects with the event outside its replay window rebuilds the
    // same pane, not a generic one (#746). Null when a (pre-#746) daemon's
    // in-memory entry lacks them; the client falls back to a generic summary.
    kind: string | null;
    title: string | null;
    summary: string | null;
  } | null;
  transcript: {
    lastSeq: number;
    recentEvents: unknown[];
  };
}
```

## Follow-On

After Slice 1 lands, wire one client first. Prefer the TUI reconnect path: it
already has reconnect state, daemon attach, and provider/model hydration, so it
will expose packet gaps quickly. Mobile should consume the same packet after the
contract proves boring.
