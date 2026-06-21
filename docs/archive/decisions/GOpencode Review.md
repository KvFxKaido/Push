# GOpencode Review

Status: Reference, added 2026-06-21 — comparative review; suggested-priorities #1, #2, #3 prototyped 2026-06-21 (see Updates below). Broader graduation still needs a `ROADMAP.md` entry.

> **Update 2026-06-21 (a)** — Suggested-priorities #1 (liveness heartbeat) and #3 (backoff nudge) landed as prototypes on the daemon's long-lived outbound relay link. `cli/pushd-relay-client.ts` now sends a WS-level ping on `RELAY_HEARTBEAT_INTERVAL_MS` (default 20s) and `terminate()`s a connection that misses a pong/traffic window — synthesizing the `close` a half-open link never delivers and routing it into the existing reconnect ladder; the heartbeat suspends while the send buffer is backlogged so a slow-but-live transfer isn't false-killed (`RELAY_HEARTBEAT_BUFFER_SUSPEND_BYTES`). A `nudge()` handle method collapses a pending backoff wait (or an exhausted/stranded state) and re-dials from the top of the ladder, but is a no-op while the link is healthy or a dial is in flight — the reusable pure primitive for the TUI link is `nudgeReconnect()` in `cli/tui-daemon-reconnect.ts`. Tests: `cli/tests/pushd-relay-client.test.mjs` (half-open kill + healthy-link survival + nudge from exhausted/no-op-while-open), `cli/tests/tui-daemon-reconnect.test.mjs` (nudge resets the ladder). (PR #1051.)

> **Update 2026-06-21 (b)** — Suggested-priority #2 (server-side ping) and the web/Capacitor half of #3 landed. **#2:** `cli/pushd-ws.ts` now runs the accept-side heartbeat mirror — a server interval pings each open connection (`DEFAULT_HEARTBEAT_INTERVAL_MS`, 30s) and terminates any that missed the previous round's pong/traffic, so a vanished phone's half-open socket is reaped and its `cleanup()` (abort in-flight `sandbox_exec` runs + deregister session clients) fires promptly instead of waiting on a TCP timeout; same `bufferedAmount` suspension, logged as `pushd_ws_heartbeat_half_open`. **#3 (web):** the environment "try now" signal is wired via `app/src/lib/reconnect-nudge.ts` (`shouldNudgeReconnect()` pure guard + `subscribeReconnectNudges()` listener plumbing for `online` / foreground `visibilitychange`), consumed by both `app/src/hooks/useLocalDaemon.ts` and `app/src/hooks/useRelayDaemon.ts` so network-restore / app-foreground collapses a pending backoff wait — but only when parked in a dropped/exhausted state. Tests: `cli/tests/pushd-ws.test.mjs` (half-open reap + healthy-link survival), `app/src/lib/reconnect-nudge.test.ts` (guard table + listener fire/cleanup + no-DOM safety). Suggested-priorities #4 (OTA bundle for the Capacitor shell) and #5 (wedged-session UX vocabulary) remain unstarted.

Origin: external repo — [`millnara/GOpencode`](https://github.com/millnara/GOpencode).

Comparative review of [GOpencode](https://github.com/millnara/GOpencode) against Push's remote-reach surface. GOpencode is conceptually *Push's pushd/relay story shipped as a standalone product*: a Capacitor Android app + a Go desktop gateway that lets a phone drive `opencode` running on your own machine over flaky networks. The crucial difference is the center of gravity — **GOpencode owns none of the agent runtime**; it is a thin remote-control client over someone else's agent. So essentially all of its engineering went into exactly the layer Push has invested *least* in: the local-machine reach path (CLI → daemon → relay → phone) that `CLAUDE.md` calls "the lead with more reach." That makes it a useful battle-tested reference for the **transport/session-resilience** layer, not for the runtime.

## What GOpencode Actually Is

A three-tier system:

- **Phone app** — React 18 + TypeScript + Vite + Capacitor 6 (native Android). Streaming chat over SSE, tool-call visualization, permission/question prompts, message queue, filesystem browser, model/agent selection, slash commands.
- **Desktop gateway** — a Go system-tray app that proxies the phone's WebSocket to the local `opencode` HTTP API, runs QR pairing, detects network endpoints (LAN / public IPv4+IPv6 / Tailscale), serves the app bundle for OTA, and pushes new endpoints when the public IP rotates. Binds `0.0.0.0:8765` when a public IP exists so it's reachable from cellular without a VPN.
- **Transport** — WebSocket (with an optional WebRTC data-channel upgrade), HTTP+SSE to `opencode`, AES-GCM-encrypted local credential storage, multi-endpoint failover, keepalive heartbeat.

The whole product is a connectivity + mobile-UX shell. That is precisely its value as a reference.

## Where Push Stands Today

Push already matches or exceeds GOpencode on the runtime side (locked roles, sandbox providers, coder checkpoints/resume, run-host adoption, resumable sessions, drift-guarded protocol). On the **transport** side Push is solid but narrower than GOpencode:

- `cli/tui-daemon-reconnect.ts` — a pure reconnect state machine: exponential backoff `[1s…30s]`, retries forever at the cap, exposes a live countdown for the footer chip.
- `cli/pushd-relay-client.ts` — the daemon's outbound dialer to the Worker relay: the same `[1s…30s]` ladder with a max-attempts cap, fatal-vs-transient upgrade-rejection classification, pre-open frame buffering, strict token hygiene.
- `app/src/lib/sandbox-connectivity-notifications.ts` — reconnecting/ready/idle/error toasts.

What Push's transport layer **lacked before this review** is the thing GOpencode's mobile focus forced it to solve: detection of connections that die *without* an observable terminal.

## Architecture Comparison

### Connection liveness

| | GOpencode | Push (before) | Push (after #1) |
|---|---|---|---|
| **Dead-link detection** | ping every 2s after 10s idle; terminate if no pong in 15s; suspend on high `bufferedAmount` | reacts only to `close`/`error`/non-101 upgrade — **half-open links never surface** | WS ping on `RELAY_HEARTBEAT_INTERVAL_MS`, terminate on missed pong/traffic, suspend on backlog |
| **Reconnect ladder** | aggressive `0.5→30s` / standard `1→120s` | `[1s…30s]` ×6 | unchanged — heartbeat feeds the existing ladder |

**Verdict / borrowed**: This is the one real correctness gap, and the highest-value borrow. On cellular/NAT a TCP connection routinely goes half-open — the peer is gone but no FIN/RST arrives, so `ws` never emits `close` and the backoff ladder never arms; the daemon sits "open" against a dead relay forever. An app-level ping with a bounded pong window is the *only* thing that surfaces that state. Prototyped on the relay client (suggested-priority #1).

### Backoff recovery on environment change

| | GOpencode | Push (before) | Push (after #3) |
|---|---|---|---|
| **"Try now" nudge** | resets backoff instantly on app-focus / network-restore | none — must wait out the full backoff | `nudge()` collapses the wait + resets the ladder, no-op while healthy; pure primitive `nudgeReconnect()` |
| **Terminal/stranded state** | distinct "stranded" indicator after 10 fails, 5-min cadence | retries forever at 30s cap, no distinct state | unchanged (see #5 below) |

**Verdict / borrowed**: The nudge is cheap and high-impact — reopening the app or regaining signal should retry immediately, not after up to 30s. Prototyped (suggested-priority #3). The pure `nudgeReconnect()` deliberately differs from the existing `cancelReconnect()`: cancel preserves the attempt count (the disconnect happened — keep climbing), nudge zeroes it (something changed — start fresh).

### Multi-endpoint failover

| | GOpencode | Push |
|---|---|---|
| **Endpoint set** | ordered LAN → public IPv4/IPv6 → Tailscale, 3.5s per-try, prefer-last-successful, self-heal via `/pairing` re-query | single relay URL; the Worker relay already solves NAT traversal |

**Verdict / not adopted now**: Push's Cloudflare-relay topology means the daemon dials *one* well-known Worker URL rather than racing LAN/public/Tailscale candidates, so most of GOpencode's failover machinery is moot. The transferable idea is narrower: the daemon's *loopback* discovery (`pushd.port` file) plus the relay could form a two-candidate set (loopback when co-located, relay otherwise) with prefer-last-successful. Worth a spike only if a "phone on the same LAN as the daemon" fast path is ever wanted; not pursued here.

### Server-side liveness

GOpencode's gateway pings clients too. Push's `cli/pushd-ws.ts` accepts inbound WS connections (loopback today; relay-fanned phones via the shared wsState) and has **no** server-side ping — a phone that vanishes leaves its session-client emit registered until something else trips cleanup. Symmetric with #1 but on the accept side.

**Verdict / suggested-priority #2 (prototyped — Update b)**: added the canonical `ws` server heartbeat (interval ping + terminate on missed pong) in `startPushdWs`, terminating dead connections so `cleanup()` (which already aborts in-flight `sandbox_exec` runs and deregisters session clients) fires promptly instead of waiting on a TCP timeout.

### OTA bundle updates for the Capacitor shell

GOpencode serves its web bundle from the gateway; the phone fetches+caches it on reconnect (bootstrapped in `index.html` before React), so app iteration needs no Play Store round-trip. Push's Android is "experimental, debug-only" and `app/android/` is gitignored — meaning **no update path at all** today.

**Verdict / suggested-priority #4 (unstarted)**: since Push already runs a Worker, serving a versioned bundle the Capacitor shell fetches on launch is a clean answer to "iterate on Android without store round-trips." Security note: a remote-fetched bundle is a code-delivery channel — it must be integrity-pinned and origin-locked, which deserves its own decision before any prototype.

### Session UX vocabulary

GOpencode exposes a *"wedged session"* badge + one-tap resume + *undo-to-any-previous-user-message*. Push has the harder machinery already (`app/src/lib/run-checkpoint-capture.ts`, `checkpoint-manager.ts`, run-host adoption) but surfaces it as generic resume/checkpoints.

**Verdict / suggested-priority #5 (unstarted)**: this is presentation, not new infra — a "wedged" affordance and an "undo to message N" verb layered over the existing checkpoint store. Pairs naturally with a "stranded" connection indicator (the backoff-terminal state GOpencode shows and Push currently lacks).

## What Not to Borrow

- **The WebRTC data-channel upgrade.** GOpencode adds it for LAN throughput; Push's relay already handles NAT traversal, so the complexity buys little.
- **A second daemon language.** GOpencode's gateway is Go; Push's equivalent is `pushd` + `app/src/worker/relay-do.ts`. No reason to add Go.
- **GOpencode's broad multi-endpoint failover** — see above; the topology difference makes most of it moot.

## Suggested Priorities

1. **Liveness heartbeat on the relay link** — closes the half-open-connection correctness gap. *(Prototyped — Update a.)*
2. **Server-side heartbeat in `pushd-ws.ts`** — the accept-side mirror of #1; prompt `cleanup()` of vanished clients. *(Prototyped — Update b.)*
3. **Backoff nudge on network-restore / app-foreground** — eliminate up-to-30s reconnect latency after an environment change. *(Prototyped — relay-client `nudge()` + pure primitive in Update a; web/Capacitor `online`/foreground wiring in Update b.)*
4. **OTA bundle for the Capacitor shell** — an Android update path; needs an integrity/origin decision first.
5. **Wedged-session UX + stranded indicator** — presentation over existing checkpoint/backoff machinery.
