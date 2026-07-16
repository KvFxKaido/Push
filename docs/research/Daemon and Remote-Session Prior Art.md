# Daemon and Remote-Session Prior Art

**Status:** Reference — prior-art survey mapping open-source daemon/remote-session
designs onto pushd's architecture; no adoption decision. Findings feed the
post-decomposition tracks (lifecycle, reconnect cost, child-session streaming,
relay hardening). Written the day the
[`Pushd Decomposition Plan`](../runbooks/Pushd%20Decomposition%20Plan.md) closed,
because the module seams it produced are where any of these designs would land.

**Date:** 2026-07-16

## Why this exists

pushd independently converged on most of the canonical session-daemon patterns:
sequence-numbered event replay, per-client capability negotiation at attach,
restart policies literally named after systemd's (`on-failure`/`always`/`never`),
outbound-dial relay for NAT traversal, and idle-grace lifecycle exit. That
convergence is validation, not coincidence — these are the shapes the problem
forces. The value of the survey is therefore *not* redesign; it is (a) a
shopping list for the deferred features, ranked at the bottom, and (b) named
precedents to cite when someone proposes simplifying away a load-bearing part.

Verdicts are design-level (docs/protocol reads, not full source reads).

## The session-daemon lineage — attach/detach, multi-client

**tmux** is the direct ancestor of the model: client/server over a Unix socket,
sessions outlive clients, multiple clients attach to one session. The
under-appreciated part is **control mode** (`tmux -CC`): a line-oriented,
machine-readable protocol variant of the same daemon, on which iTerm2 builds a
complete native UI. Two pulls:

- **Addressing grammar.** tmux names nested targets with a stable grammar
  (`session:window.pane`). This is the worked answer to "how does a client name
  a nested thing it wants to stream" — the exact question
  `attach_child_session` (deferred; children are currently poll-only views via
  `list_children` / `get_child_session` / `fetch_delegation_events`) will have
  to answer. pushd's `subagentId` is already the stable token; control mode
  shows what the *verb surface* around it should look like (subscribe, resize,
  detach semantics per target).
- **Per-client feature variance.** tmux negotiates terminal features per
  client on one session — same problem pushd solves with per-client capability
  sets and v1 downgrade synthesis in the fan-out. Precedent that the
  per-client-shadow approach scales.

**Zellij** resurrects sessions by serializing *layout/shape* to disk and
rebuilding, rather than replaying history. A different recovery axis than
`recoverInterruptedRuns` (which recovers the run); worth knowing it exists as a
pattern, not a current need.

## Reconnect and replay — the `lastSeenSeq` family

**Eternal Terminal (ET)** is pushd's replay model verbatim: sequence-numbered
buffer, reconnect with last-acked seq, server replays the tail. Nothing to
change; it confirms the shape.

**mosh** is the opposite pole and the most interesting steal. Its State
Synchronization Protocol never replays history — the client syncs to the
*current* state, however far behind it fell. pushd already owns both halves of
this trade: seq replay (ET-style) *and* the snapshot machinery (the daemon
transcript mirror + workspace-state `resync` mode). mosh is the argument for
making **snapshot-plus-tail the default reconnect path once a session's replay
window is long**: rebuild from `get_session_snapshot` + transcript mirror, then
replay only the short tail, bounding reconnect cost on long-lived sessions
instead of walking the whole event log. The mirror was built for exactly this;
mosh says: trust it harder.

**Jupyter's kernel protocol** is the cautionary tale. Kernels survive clients,
but there is no replay — a disconnected client silently loses output. Years of
user pain, eventually patched sideways by the RTC project. pushd avoided this
from the start; cite Jupyter when anyone proposes "simplify by dropping
replay."

## Lifecycle — drain, idle-exit, restart

**systemd** is where pushd's restart-policy vocabulary comes from, and its
socket-activated services are the grown-up version of the idle-grace exit. The
missing half is **socket activation** itself: the init system (systemd on
Linux, launchd on macOS) owns the socket; the daemon starts on first client
connection, idle-exits freely, and restarts transparently on the next
connection. This would replace the client-side self-heal-respawn dance with an
OS-owned guarantee on those platforms (Windows keeps the named-pipe + spawn
path). The decomposed spine makes the wiring point visible: `main()`'s socket
setup is ~20 lines that would learn to accept an inherited fd.

**SSH ControlMaster/ControlPersist** — multiplexed connections over a control
socket with an idle persist timeout. Same shape as the lifecycle grace; useful
edge-case study for what happens to in-flight channels when persist expires
(answer: they hold the master open — pushd's equivalent is the drain
idle-watcher refusing to exit while runs are active, which is the same
decision).

## Remote reach — the relay

**Tailscale's DERP** is the closest production analog to the relay DO:
encrypted frames relayed through cloud infrastructure, **outbound dial only**
(never listen; NAT traversal by construction), per-connection source
authentication. pushd's DO-stamped `relaySenderId` (Audit #3) is DERP's
src-auth in miniature, and the hashed phone allowlist is the same
"relay-side authorization is cheap-to-check, daemon-side is authoritative"
split. Before the relay handles more than one paired phone per user or any
multi-region concern, read DERP's notes on abuse resistance, per-region
failover, and mesh key rotation — they are the failure modes pushd hasn't hit
yet.

**CI runner agents** (GitHub Actions runner, Buildkite agent) are the same
outbound-dial pattern at fleet scale, with the control plane owning work
assignment. Only relevant if pushd ever supervises multiple daemons per
account; noted so the precedent is on file.

## Crash recovery

**kubelet reconciliation** is the industrial version of
`recoverInterruptedRuns` + orphan detection: on restart, enumerate *actual*
state, diff against *desired*, reconcile — never trust markers alone. The
`DELEGATION_INTERRUPTED` scan is already a small reconciler over the event
log. If recovery ever needs to get more ambitious (recovering delegations
rather than declaring them lost), kubelet's actual-vs-desired framing is the
pattern; today's "recover the parent, declare children lost, tell the model"
is deliberately narrower and should stay that way until there's a concrete
need.

**Docker Engine's API** — REST over a Unix socket with client/server version
negotiation per connection. pushd's `hello` capability negotiation is the same
mechanism; Docker is precedent that it ages well across years of protocol
growth.

## What to actually steal, ranked

1. **Socket activation** (systemd/launchd) — replaces bespoke lifecycle
   machinery with OS guarantees on Linux/macOS; natural next runbook now that
   the spine is small enough to see the wiring point.
2. **mosh-style snapshot-first reconnect** for long sessions — bounds replay
   cost; the transcript mirror and workspace-state resync already exist, this
   is a policy change in the attach path, not new machinery.
3. **tmux control-mode addressing** — the design template to reach for when
   `attach_child_session` comes off the deferred list.
4. **DERP abuse-resistance notes** — pre-reading for the next relay hardening
   pass, before multi-phone or multi-region traffic exists.

None of these are scheduled; each cites the module the decomposition gave it a
seam in (`paths.ts`/`main()` for 1, `core-session-handlers.ts` attach path for
2, `child-session-handlers.ts` for 3, `relay-coordinator.ts` for 4).
