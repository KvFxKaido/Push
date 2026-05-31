# Remote Control Surface Audit — TUI / Daemon Exposure

Date: 2026-05-31
Status: **Reference** (findings snapshot) — companion to
[`Addressable Session Verbs.md`](Addressable%20Session%20Verbs.md) (verb vocabulary)
and [`Universal Session Bearer.md`](Universal%20Session%20Bearer.md) (auth layer).
This doc records what's *exposed* across the remote-control surface, not what the
verb contract *should* be named.
Owner: Push

## Why this exists

Triggered by a "anything obviously missing on the tui/daemon side?" pass while
connected over Remote Control. The headline finding: **the daemon's verb surface
has outrun the TUI's exposure of it.** The protocol layer is mature; the terminal
client only drives a subset of what the wire can do, and the remaining gaps are a
mix of one real architectural hole, two flagged follow-ups, and several stale
comments that will mislead the next reader.

Confidence is noted per finding. Everything here is read from code at the cited
`file:line`; treat line numbers as of the 2026-05-31 `main` (commit `a0edcf73`).

## The surface is mature (baseline)

So the gaps below read in context — the daemon already exposes, bearer-gated:

- **Lifecycle**: `start_session`, `attach_session` (+ replay), `send_user_message`,
  `get_session_messages`, `update_session`, multi-client, crash recovery.
- **Addressable verbs**: `cancel_run`, `cancel_delegation`, `abort`,
  `list_children`, `get_child_session`, `session_summarize`, `session_revert` /
  `session_unrevert`, `configure_role_routing`, `fetch_delegation_events`.
- **Delegation, all four kinds wired to real `executeToolCall`**: explorer, coder,
  reviewer, deep-reviewer — plus `task_graph_v1` and `event_v2` (with a v1
  downgrade path in `cli/v1-downgrade.ts`).
- **Sandbox**: read / write / list / diff / exec.
- **Pairing & relay**: device tokens, attach tokens, `relay_enable` / `disable` /
  `status`, pair bundles, allowlist reseed-on-restart
  (`seedRelayAllowlistFromAttachTokens`).

The advertised capability set (`cli/pushd.ts:670` `CAPABILITIES`) confirms
`multi_agent`, `task_graph_v1`, `event_v2`, and all four `delegation_*_v1` flags
are live.

## Findings

### 1. TUI exposure asymmetry — the daemon has verbs the terminal can't trigger

**Confidence: high (confirmed by absence + an explicit design comment).**

The daemon exposes the addressable session verbs over the wire, but the TUI
**only reacts to them — it never initiates them.**

- The TUI command surface is the `switch (cmd)` at `cli/tui.ts:4813` and its
  `/help` listing (`cli/tui.ts:4843`). It has **no** `/revert`, `/unrevert`,
  `/summarize`, `/children`, or child-inspect command.
- The TUI never *sends* `session_summarize` / `session_revert` /
  `session_unrevert` / `list_children` / `get_child_session` /
  `fetch_delegation_events` — grep across `cli/tui.ts`, `cli/daemon-client.ts`,
  `cli/tui-*.ts` returns zero send sites.
- It **does react**: `session_reverted` / `session_unreverted` / `context_compacted`
  drive a real transcript resync via explicit cases in `handleEngineEvent` →
  `resyncDaemonTranscript` (`cli/tui.ts:2780`, design note at
  `cli/tui-daemon-handshake.ts:76-81`). So a **paired phone can revert or
  summarize a session and the TUI dutifully resyncs its transcript** — but a TUI
  user can't perform the same operation from the terminal.

**Already wired, for the record:** `cancel_run` *is* TUI-initiable — Ctrl+C in
daemon mode sends a real bearer-gated `cancel_run` RPC (`cli/tui.ts:3093`). Child
activity is rendered **passively** as `subagent.*` event streams
(`cli/tui-delegation-events.ts`), so the user sees delegations happen — there's
just no on-demand "list children / inspect this child" affordance.

**Easy to mistake for coverage:** `/compact` and `/checkpoint` (`cli/tui.ts:5002`,
`:5006`) are **TUI-local engine features**, *not* the daemon's `session_summarize`
/ `session_revert` verbs. Seeing them in `/help` does not mean the addressable
verbs are exposed.

**Net:** the bearer + addressable-verb work built a control surface that today is
only fully drivable from the *web/phone* client. The TUI is a second-class
consumer of its own daemon's verbs. This is the "obviously missing" piece.

**Status — addressed 2026-05-31 (this change).** The TUI now exposes the verbs:
`/revert [n]` (`session_revert`), `/unrevert` (`session_unrevert`), `/children
[subagentId]` (`list_children` / `get_child_session`), and `/compact` is now
daemon-aware — in daemon mode it routes to `session_summarize` instead of editing
the dead local `state.messages` mirror (which fixes a latent divergence: that
mirror is never appended to over the socket, so local compaction was a no-op the
next resync would overwrite). The session-verb commands call a shared
`ensureDaemonSessionReady()` so they work immediately after `/resume` (the
`daemonSessionId` is populated lazily, like the send path). Success paths converge
through the existing `session_reverted` / `session_unreverted` / `context_compacted`
→ `resyncDaemonTranscript` flow, now enriched with the counts the event payload
already carries (so a *phone*-initiated revert also shows specifics in the TUI).
Error envelopes reject through `daemonClient.request` (it rejects on `ok:false`
with `err.code`), so `NOTHING_TO_UNREVERT` renders as a status, not an error.
Verified end-to-end against a live daemon (revert/unrevert/compact-noop/children
list+inspect+not-found). `cancel_run` was already TUI-initiable (Ctrl+C).

### 2. PR delivery is dead in local-daemon mode

**Confidence: high (explicit capability strip).**

`LOCAL_DAEMON_REMOTE_ONLY_CAPS` at `lib/capabilities.ts:365` strips `pr:write` and
`workflow:trigger` from **every** role in `local-daemon` mode, because "the paired
pushd session has no GitHub remote wired up." So `create_pr` / `merge_pr` /
`delete_branch` / `trigger_workflow` all deny at the capability gate.

Consequence: a remote-controlled local daemon can code, commit, and raw-`git push`
via `sandbox_exec`, but **cannot use the typed PR-delivery tools** — and Push's
entire delivery model is "PR flow only, never local merge" (see root `CLAUDE.md`
→ Delivery rules). Remote control on a local daemon can build but can't ship
through the sanctioned path.

This is distinct from the deferred cloud-sandbox git-credential-proxy work; here
it's specifically the *local-daemon* runtime having no GitHub API token plumbed
in. Closing it means deciding how a GitHub token reaches the local-daemon runtime
(reuse the user's `gh` auth? a scoped token in `~/.push/`?), then removing the
strip for that path.

### 3. Cross-phone cancel is not identity-scoped

**Confidence: high (flagged follow-up).**

`cli/pushd.ts:363` — the relay path shares one `activeRelayWsState`, so a
`sandbox_exec`'s AbortController and a later `cancel_run` from *any* relay-paired
phone land in the same map. One phone can cancel another phone's run by guessing
the `runId`. Documented as a post-#530 hardening follow-up; still open. Low blast
radius at single-user, but it's a real multi-client correctness gap.

### 4. Delegation audit is coarse

**Confidence: high (explicit comment).**

`cli/pushd.ts:164` — `delegate.*` audit events fire as soon as the handler
*returns* (the delegation is accepted), with no paired `delegate.complete` when
the run actually finishes. The audit log can't distinguish a kicked-off
delegation from a completed one. A `delegate.complete` emitted from the agent
bindings on terminal return would close it.

### 5. Stale capability docblocks (cosmetic, but actively misleading)

**Confidence: high (comments contradict shipped code in the same file).**

These read as "missing" but are **already shipped** — worth fixing in place so
nobody re-implements them:

- `cli/pushd.ts:4416` — "Explorer still runs through the scaffold executor — its
  real tool wiring is a follow-up." **False:** `handleDelegateExplorer` runs
  `runExplorerAgent` with `makeDaemonExplorerToolExec` → real `executeToolCall`
  (`cli/pushd.ts:4211`, `:4636`).
- `cli/pushd.ts:4067-4068` and `:4423-4425` — "flipping `multi_agent` still blocks
  on a real daemon-side tool executor." **False:** `multi_agent` is in the
  advertised `CAPABILITIES` list (`cli/pushd.ts:719`) and both executors are real.

### 6. TUI daemon autostart spawns stale compiled `dist` with no staleness guard

**Confidence: high (observed live during #1 verification).**

`./push` checks whether any `cli/`/`lib/` source is newer than
`cli/dist/cli/cli.js` and falls back to `tsx` (running from source) with a warning
when it is. The TUI's daemon **autostart** has no equivalent guard: it spawns
`node cli/dist/cli/pushd.js` unconditionally. With a stale `dist`, the daemon runs
old code while the TUI runs fresh source via `tsx` — a silent version skew. During
#1's verification this surfaced as every new verb returning `Unknown request type`
because the on-disk `dist` predated the addressable verbs entirely (`grep -c
list_children cli/dist/cli/pushd.js` → 0). Pre-existing and orthogonal to #1, but
it's a genuine dev-experience footgun: either spawn the daemon via the same
source-preferring launcher logic, or apply the staleness check before spawning and
warn/rebuild. Low priority, but worth a `log()` at minimum so the skew isn't
silent.

### 7. `attach_child_session` live fan-out — deferred (not a gap)

`list_children` + `get_child_session` are read/summary verbs; there's no focused
live-tail of a *specific* child over the wire (`cli/pushd.ts:3474`). This is a
**deliberate non-build** per [`Addressable Session Verbs.md`](Addressable%20Session%20Verbs.md)
(deferred as redundant — child output already streams via `subagent.*` under
`event_v2`). Listed here only so it isn't re-discovered as a surprise.

## Suggested sequencing

Ordered by value / cost, not committed (needs a `ROADMAP.md` entry to become work):

1. **TUI verb exposure (#1)** — ✅ **done 2026-05-31.** `/revert`, `/unrevert`,
   `/children`, and daemon-aware `/compact` now drive the existing bearer-gated
   verbs; verified live.
2. **PR delivery in local-daemon (#2)** — the one architectural decision. Scope a
   GitHub-token path for the local-daemon runtime, then narrow the capability
   strip. Bigger than the rest; warrants its own decision doc.
3. **Doc-drift cleanup (#5)** — five-minute fix, do it opportunistically next time
   anyone touches `handleDelegate*`.
4. **Cross-phone cancel scoping (#3)** and **delegate.complete audit (#4)** —
   hardening; fold into the next relay/audit-touching PR.

## Cross-references

- [`Addressable Session Verbs.md`](Addressable%20Session%20Verbs.md) — canonical
  verb vocabulary; this doc audits their *exposure*, not their naming.
- [`Universal Session Bearer.md`](Universal%20Session%20Bearer.md) — the auth layer
  the verbs sit on.
- Root `CLAUDE.md` → Delivery rules — why #2 matters (PR-only delivery).
