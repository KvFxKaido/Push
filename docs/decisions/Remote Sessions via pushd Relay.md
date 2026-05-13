# Remote Sessions via pushd Relay

Date: 2026-05-07 (Phase 1 substrate + first-tool dispatch shipped 2026-05-11 → 2026-05-12; chat-layer wiring, tool-op fan-out, and UI half landed 2026-05-12; 1.f hardening, Phase 3 slices 1–4, and Phase 2 storage decision (2.a) landed 2026-05-13)
Status: **Phase 1 + Phase 3 shipped; Phase 2 in progress (2.a–2.e shipped, 2.f open)** — Phase 1.a–1.f (#507–#511, 3c.2a/b, 3c.3, auto-reconnect 2026-05-13) and Phase 3 slices 1–4 (#518–#521) landed. Phase 2 storage shape locked 2026-05-13: DO in-memory ring buffer, no durable storage (see Q#2 + Phase 2 sub-phase table). Phase 2.b (#524), 2.c (#525), 2.d.1 (#526), 2.d.2 (#528), and 2.e (#529) landed 2026-05-13. Remaining: Phase 2.f (phone client adapter + UI), Phase 4 (desktop wrapper).
Owner: Push
Related: `docs/cli/design/Push Runtime Protocol.md`, `docs/decisions/Web and CLI Runtime Contract.md`, `docs/decisions/push-runtime-v2.md`, `docs/decisions/Diff and Annotation Envelope.md`

## Shipping status

The shipped scope diverged from the original Phase 1 enumeration in one way: the connector substrate is more complete than spec'd (full WS adapter, paired-device UI, mode chip, IndexedDB storage, dispatch seam). Otherwise the track now matches the original Phase 1 vision end-to-end: a paired Local PC session has a real chat, the chat round loop routes sandbox tool calls through the daemon (`sandbox_exec` / `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir` / `sandbox_diff`), the Stop button halts the turn AND interrupts the in-flight daemon child via `cancel_run`, and a dropped WS auto-reconnects with exponential backoff up to 5 attempts before surfacing a manual Retry banner. Phase 3 (permission + audit model + `submit_approval` UI) shipped via #518–#521. Phase 2 storage decision locked 2026-05-13 (Q#2; see Phase 2 sub-phase table); Phase 2.b–2.f code track and Phase 4 desktop wrapper still open.

| Sub-phase | Scope | Status | PRs |
|---|---|---|---|
| 1.a — Transport + protocol substrate | WS listener on pushd, device-token pairing with origin binding, shared `lib/protocol-schema.ts`, web adapter with subprotocol auth | Shipped 2026-05-11 | #507, #508, #509 |
| 1.b — Pairing UI + paired workspace | Flag-gated `VITE_LOCAL_PC_MODE` Local PC tile on Onboarding + Hub, pairing panel, paired workspace shell with mode chip + ping probe, IndexedDB `paired_devices` store, bearer token kept out of localStorage | Shipped 2026-05-12 | #510 |
| 1.c — Dispatch seam + first tool | `SandboxExecutionOptions.localDaemonBinding` threaded; `executeSandboxToolCall`'s `sandbox_exec` case forks on it; `LocalDaemonUnreachableError` → `SANDBOX_UNREACHABLE` with re-pair hint; `daemon_identify` round-trip fills the paired-state UI; Codex P2 fix for `!sandboxId` guard so the local-pc arm (`sandboxId: null`) reaches the fork | Shipped 2026-05-12 | #511 |
| 1.d — Chat-layer wiring (runtime half) | `localDaemonBindingRef` added to `SendLoopContext` + `ToolExecRunContext` + `lib/` `ToolExecutionContext`; `useChat` exposes `setLocalDaemonBinding`; all three `ToolExecRunContext` build sites (single + parallel + mutation batch) read the ref; `executeAnyToolCall` and `WebToolExecutionRuntime.execute()` forward it; the runtime-layer `!context.sandboxId` short-circuit relaxed to also allow a binding (mirrors the PR #511 fix at the dispatcher layer); `executeSandboxToolCall` now invoked with `options.localDaemonBinding` set. Chat-layer test pinned in `web-tool-execution-runtime.test.ts` ("local-daemon binding propagation"). | Shipped 2026-05-12 (runtime half) | PR 3c.2a |
| 1.d — Chat-layer wiring (UI half) | New `LocalPcChatScreen` replaces the probe-only `LocalPcWorkspace`: mounts `useChat` with minimal cloud-free args, runs `setLocalDaemonBinding(session.binding)` via effect, hosts a compose textarea + send button and a Stop button in the header. `WorkspaceScreen` now routes `kind: 'local-pc'` here instead of `LocalPcWorkspace` (deleted). Cloud-shaped affordances (sandbox controller, branch sync, snapshot manager, file browser) are intentionally absent — the daemon binding IS the transport. Provider/model picker chip shipped 2026-05-13 (`LocalPcModelPicker` in the input area surfaces the current orchestrator provider + model leaf and lets the user switch providers in-place via `setPreferredProvider`; per-provider model id editing stays in Settings). Attachments + multi-chat sidebar still deferred. | Shipped 2026-05-12 + 2026-05-13 (picker) | PR 3c.2b + claude/local-pc-model-picker |
| 1.e — Remaining tool-op fan-out | Per-tool recipe applied to `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_dir`, `sandbox_diff`: pushd handler in `cli/pushd.ts` (re-roots `/workspace/`-prefixed paths against the daemon cwd; runs git diff HEAD + status --porcelain for diff), `local-daemon-sandbox-client` method, dispatch fork case in `sandbox-tools.ts` (with shared `runLocalDaemonTool` helper that maps `LocalDaemonUnreachableError` → `SANDBOX_UNREACHABLE`), `LOCAL_DAEMON_SUPPORTED_TOOLS` set extended in lockstep. Result shapes intentionally minimal — no version cache, no workspace-revision tracking, no card formatting yet. | Shipped 2026-05-12 | PR 3c.3 |
| 1.f — Cancel button | Stop button in `LocalPcChatScreen` header, conditional on `isStreaming`, calls `abortStream` to halt the in-flight web round AND to fire `cancel_run` on the same WS so the daemon SIGTERMs the registered child mid-run (see daemon-side cancellation row below). | Shipped 2026-05-12 (web-side abort), extended 2026-05-13 (daemon-side cancel) | PR 3c.2b, claude/remote-sessions-auto-reconnect |
| 1.f — Auto-reconnect with backoff | `useLocalDaemon` schedules retries on `unreachable` along a fixed `[1s, 2s, 4s, 8s, 16s, 30s]` ladder, capped at 5 attempts. Successful open resets the counter; exhaustion flips a `reconnectInfo.exhausted` flag the `ReconnectBanner` in `LocalPcChatScreen` surfaces as a manual Retry. The hook accepts `backoffScheduleMs` / `maxReconnectAttempts` options as test seams. | Shipped 2026-05-13 | claude/remote-sessions-auto-reconnect |
| 1.f — Daemon-side mid-run cancellation | `pushd-ws.ts` maintains a per-WS `wsState.activeRuns: Map<runId, AbortController>` plumbed into `handleSandboxExec` via the dispatcher context. The exec handler registers an AbortController under the payload's `runId` and passes its signal to `runCommandInResolvedShell`; the SAME-connection `cancel_run` (sessionId omitted, runId required) aborts the child and returns `cancelled: true`. The web client mints a `runId` per call and, when the chat hook's `abortControllerRef.signal` fires, sends `cancel_run` on the same transient binding before rejecting with `AbortError`. Cross-WS cancel is refused on purpose — the active-runs map is connection-scoped, not global. | Shipped 2026-05-13 | claude/remote-sessions-auto-reconnect |
| 1.f — Approval UI (submit_approval) | `LocalPcChatScreen` subscribes to daemon `approval_required` events via a new `useLocalDaemon({ onEvent })` callback and queues them into a FIFO; `ApprovalPrompt` renders the head with Approve / Deny; clicks dispatch `submit_approval`. The originally-deferred surface turned out to have a real consumer after all: daemon-side delegated agents (`delegate_coder` etc.) emit `approval_required` and silently timed out at 60s with no web listener. Slice 4 closes that gap and emits `approval.decision` audit events. | Shipped 2026-05-13 (slice 4) | claude/remote-sessions-phase3-submit-approval |
| 2 — Worker-mediated relay | Outbound-from-PC WebSocket to a Worker/DO that pairs phone client to daemon. Storage shape decided 2026-05-13 (DO in-memory ring buffer, Q#2 below); sub-phase breakdown drafted in the Phase 2 sub-phase table below. | In progress (2.a–2.e shipped, 2.f open) | #524 · #525 · #526 · #528 · #529 |
| 3 — Permission + audit model | Repo allowlist, per-session attach token, connected-device list, audit log with surface/device provenance. | **Core shipped** — slice 1 (allowlist + connected-device list + live revoke) via #518; slice 2 (device-attach token + cascade) via #519; slice 3 (NDJSON audit log with size-rotation + structural-only privacy default) via #520; slice 4 (submit_approval UI + `approval.decision` audit event) via #521. All four minimum-model items shipped. | #518 · #519 · #520 · #521 |
| 4 — Desktop wrapper | Tray/menu-bar packaging, `pushd` at login, pairing UI. Polish, not core. | Open | — |

### Phase 2 sub-phases (drafted 2026-05-13)

| Sub-phase | Scope | Status | Branch / PR |
|---|---|---|---|
| 2.a — Decision lock | Answer open Q#2 in this doc (DO in-memory ring buffer, no durable storage); draft this Phase 2 sub-phase table; flip the Phase 2 main-table row to "In progress." No code. | Shipped 2026-05-13 | claude/phase-2-relay-storage-TfQfR |
| 2.b — Relay DO scaffold | New `RelaySessionDO` class using plain WebSockets (no Hibernation API — the in-memory ring buffer relies on the DO instance staying pinned for the WS lifetime; see Q#2); wrangler `RELAY_SESSIONS` DO binding; `/api/relay/v1/...` route in `worker.ts`. Accepts WS connections; no protocol forwarding or auth yet. Unit-tested via the worker test harness. | Shipped 2026-05-13 | #524 |
| 2.c — Two-sided auth | pushd authenticates with a deployment-scoped relay token (`PUSH_RELAY_TOKEN` Worker secret, `pushd_relay_*` prefix); phone authenticates with a Phase-3-style attach token (`pushd_da_*`). Bearer rides `Sec-WebSocket-Protocol`. DO tracks per-connection role and forwards bytes between pushd and phones. Phone-attach VERIFICATION is deferred to 2.d.1 (originally scoped here, but the design needs envelope parsing — see Codex P1 deferral and the sub-row below). | Shipped 2026-05-13 | #525 |
| 2.d.1 — Envelope parsing + phone allowlist | New relay-control envelopes in `lib/protocol-schema.ts`: `relay_phone_allow`, `relay_phone_revoke` (pushd → relay; build/maintain the phone allowlist), `relay_attach` (phone → relay; schema lands here, replay runtime is 2.d.2), `relay_replay_unavailable` (relay → phone; schema lands here, emitted in 2.d.2). DO parses incoming text frames; consumes relay-control envelopes in-band; forwards everything else unchanged. **Both forwarding directions (pushd ↔ phone) are gated on the phone bearer being in pushd's allowlist** — closes the Codex P1 deferred from 2.c plus the symmetric phone → pushd gap surfaced in #526 review. Drift-detector pin in `cli/tests/protocol-drift.test.mjs`. Decision-doc update: sessionId is an opaque routing key chosen by pushd and shared with the phone during pairing — it is NOT load-bearing for security (the allowlist is). | Shipped 2026-05-13 | #526 |
| 2.d.2 — Ring buffer + replay | Per-DO `Map<seq, envelope>` capped by both count (default `N=256`) and age (default `Y=60s`); first-to-fire evicts. After auth the phone client sends an initial `relay_attach` envelope carrying its last-seen `seq` (schema landed in 2.d.1). Relay replays envelopes after that `seq` if still buffered; a gap larger than the buffer emits `relay_replay_unavailable` so the client falls back to `attach_session` for current state rather than silently missing envelopes. Defaults overridable by env (`PUSH_RELAY_BUFFER_COUNT`, `PUSH_RELAY_BUFFER_AGE_MS`). | Open | — |
| 2.e — pushd outbound dial + reconnect | `cli/pushd-relay-client.ts` opens an outbound WS to the Worker; reuses the Phase 1.f reconnect ladder `[1s, 2s, 4s, 8s, 16s, 30s]` capped at 6 attempts (matches `useLocalDaemon.ts` so the 30s tier is reachable — briefing's "cap 5" was an outdated literal). `push daemon relay enable\|disable\|status` CLI surface, live admin RPCs (`relay_enable` / `relay_disable` / `relay_status`) so config changes take effect without a daemon restart. Audit events for `relay.connect` / `relay.disconnect` via the Phase 3 slice 3 audit log. **Origin-gate carve-out is bearer-prefix-scoped**, not auth-presence-scoped: `pushd_relay_*` skips `validateOrigin` (pushd is Node, not a CSRF target); `pushd_da_*` (phone) still enforces origin. pushd emits `relay_phone_allow` / `relay_phone_revoke` envelopes from `mint_device_attach_token` / `revoke_device_attach_token` / cascade, and re-emits the full allowlist on every `relay.connect` so a DO restart mid-session recovers. New `~/.push/run/pushd.relay.json` (chmod 0600) holds the deployment-scoped relay token. **Known limitation:** allowlist registry is process-memory-only, so a daemon restart drops every bearer entry and phones with still-valid attach tokens must re-pair before relay access works again — hash/token-id allowlisting is the deferred follow-up hardening slice. | Shipped 2026-05-13 | #529 |
| 2.f — Phone client mode + UI | Web client gains a relay adapter (sibling to the localhost WS adapter from Phase 1) and a `useRelayDaemon` hook sibling to `useLocalDaemon` (per the AGENTS.md "background tasks" guardrail — feature hooks ship as siblings, not appended to `useChat.ts`). Hub adds a "Remote" tile separate from the existing "Local PC" tile. | Open | — |

Each future sub-phase gets its own scope-confirmation before code lands. The breakdown is PR-per-row; 2.b→2.f must land in order because each depends on the previous (scaffold → auth → envelope+allowlist → buffer+replay → daemon dial → client mode).

**Walk-back from the 2.a draft:** the original 2.c row said "DO pairs them under a sessionId derived from the attach token's parent device." 2.d.1 walks that back. With the pushd-controlled phone allowlist gating forwarding, sessionId is just a routing key and not load-bearing for security. Deriving it from the attach token would require either changing the Phase 3 slice 2 token shape (breaking) or adding a sessionId field to the phone's IndexedDB pairing record (equivalent complexity to "pushd shares sessionId during pairing"). We chose the simpler shape: sessionId is opaque, pushd picks it, pushd shares it during pairing, the allowlist enforces the actual gate.

### Notable architectural decisions captured during Phase 1.a–1.c

- **Subprotocol bearer carrier** (PR #509): browser `WebSocket` constructor can't set arbitrary headers, so the bearer travels in `Sec-WebSocket-Protocol: pushd.v1, bearer.<token>`. Server picks `pushd.v1` to echo and validates the `bearer.` entry. The `bearer.*` entry is intentionally never selected back.
- **Loopback-only enforcement** at both server and client layers (defense in depth). The web adapter refuses non-loopback hosts at construction time even though the server already binds 127.0.0.1.
- **Immutable origin binding at mint time**: tokens are bound to one origin via `push daemon pair --origin <url>`. Revoke + remint to change. The web pair flow auto-fills the origin from `window.location.origin` so it can't drift.
- **Browser cannot distinguish auth-fail from connection-refused**: browsers hide the WS upgrade response from JS, so `unreachable` collapses (a) daemon not running, (b) wrong port, (c) token rejected at upgrade, (d) origin mismatch. UI surfaces a generic re-pair / retry affordance and uses context (was the user just pairing?) to decide.
- **Bearer token NOT in localStorage** (PR #510 review fix): the `workspace_session` storage path used to round-trip the entire session through `safeStorageSet`, which for local-pc would have leaked the bearer. The persistence effect now strips local-pc sessions to a bearerless tombstone before serializing; the normalize loader returns `null` for any persisted local-pc record so the user re-clicks the tile to re-hydrate from IndexedDB. One persistence path, one exfiltration surface.
- **`daemon_identify` is WS-only by construction** (PR #511): its response surface is the authenticated device-token record, which doesn't exist on the unauthenticated Unix socket. `handleRequest` gained an optional `context` argument that `pushd-ws.ts` populates with `{ record }`; the Unix-socket caller passes nothing; the dispatcher tolerates absence.
- **`!sandboxId` guard relaxed** (PR #511 review fix): `executeSandboxToolCall` short-circuited before the dispatch fork because `WorkspaceSession.local-pc` carries `sandboxId: null`. Guard now requires both `!sandboxId` AND `!options?.localDaemonBinding` to refuse. Future binding-aware forks must respect the same gating.

## Context

The product question is whether Push should let the phone PWA/APK edit files on the user's own computer while they are away from that computer.

This came up after the Cloudflare-private-deployment work because the current hosted app can be locked down, but the execution location is still remote by default: Cloudflare Worker/Assets for the app, Cloudflare or Modal for sandboxes, and GitHub/provider APIs for source and model work. That is different from "my phone drives my home/work PC checkout."

The existing CLI/TUI/daemon direction was partly built with this eventual shape in mind. The new question is whether to keep building toward a daemon-backed remote session, or instead wrap the PWA for desktop and let the desktop wrapper be the PC story.

## Decision

Build remote sessions around `pushd` as the local execution host, connected through a Worker/Durable Object relay.

```text
Phone PWA/APK
  <-> Push Worker / Durable Object relay
  <-> outbound WebSocket from pushd on the PC
  <-> local repo files and commands
```

A desktop PWA wrapper is not the core architecture. It can still be useful later as packaging:

- tray/menu bar presence
- installer and auto-update path
- start/stop `pushd`
- pair a phone with this machine
- show which repo/device/session is attached
- open the same web UI on desktop

But the wrapper should not become a second execution substrate or a forked runtime.

## Why

**Fact:** wrapping the PWA for PC solves the "desktop app edits desktop files" case, but it does not solve "phone at work edits files on a computer somewhere else" by itself.

**Fact:** `pushd` already owns the right category of concern: long-lived sessions, attach/resume, event replay, approvals, local tool execution, and the `push.runtime.v1` envelope shape.

**Inference:** the safest remote topology is outbound-only from the PC. The user should not need to expose an inbound port, run a public tunnel, or teach a browser how to reach a private LAN service from outside the LAN.

**Decision:** the cloud component should relay protocol envelopes, not execute tools. File edits, shell commands, approvals, and repo state stay anchored to the local daemon.

## Architecture Shape

The relay is a transport bridge:

- Mobile client connects to the Worker/DO session endpoint.
- `pushd` connects outbound to the same session endpoint.
- The relay authenticates both sides, pairs them to one remote session, and forwards NDJSON protocol envelopes unchanged where possible.
- The relay may buffer enough events for reconnect/replay, but it should not learn provider routing, tool semantics, branch state, or approval policy.
- `pushd` remains the authority for local filesystem access and command execution.

This lines up with the existing protocol note that a secondary remote app bridge should forward the same JSON envelopes unchanged. The new preference is that the bridge is worker-mediated for remote use, not a direct public WebSocket to the user's computer.

## Relationship To Existing Decisions

`Web and CLI Runtime Contract.md` remains the boundary rule: shared agent semantics belong in `lib/`, shell transport and UX stay shell-local.

This remote-session design does not mean "make web run through pushd immediately." The Phase 7 Web-as-daemon-client migration in `push-runtime-v2.md` is still future work. Remote sessions are the product case that can justify that migration when it is ready.

The important distinction:

- **Current web app:** web shell runs its own chat/runtime binding against the sandbox provider.
- **Remote session future:** web/mobile shell attaches to a `pushd` session whose local daemon executes against the PC checkout.
- **Desktop wrapper:** optional shell around the same daemon and web UI, not a new runtime path.

## Phases

### Phase 1: Local Connector

Make the desktop browser/app talk to `pushd` on localhost with an explicit pairing or attach token. This proves the client-to-daemon path without introducing the remote relay yet.

The goal is boring correctness:

- start or discover a local daemon — **shipped** (`push daemon start` + `~/.push/run/pushd.port`, PR #507)
- pair a client — **shipped** (`push daemon pair --origin <url>`, browser pairing panel, PR #507 + #510)
- attach to a session — pushd has `attach_session` handler; web side wires it as part of Phase 1.d (3c.2)
- stream events — **shipped** (the WS adapter validates and surfaces event envelopes via `onEvent`, PR #509)
- submit approvals — pushd's `submit_approval` handler now has a web UI consumer: `LocalPcChatScreen`'s approval-prompt queue dispatches decisions over the long-lived WS binding; `handleSubmitApproval` logs the result as an `approval.decision` audit event
- cancel/reconnect — pushd's `cancel_run` now accepts a sessionless `{ runId }` envelope routed against the per-WS active-runs map; `useLocalDaemon` schedules `[1s, 2s, 4s, 8s, 16s, 30s]` auto-reconnects (cap 5 attempts) before the banner surfaces a manual Retry
- edit files through the existing local tool surface — **shipped**: `sandbox_exec` (PR #511) plus `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir` / `sandbox_diff` (PR 3c.3). The daemon-side surface is reachable through both the runtime AND a real chat turn now that the UI half (3c.2b) has landed

### Phase 2: Worker-Mediated Relay

Add a remote-session endpoint on the hosted Worker. `pushd` opens an outbound WebSocket to the relay. The phone PWA/APK connects to the same relay session.

The relay should be deliberately small:

- authenticate devices
- pair one or more clients to one daemon connection
- forward `push.runtime.v1` envelopes
- preserve ordering per session
- support reconnect/replay within a bounded window
- expose clear connected/disconnected state

### Phase 3: Permission And Audit Model

Remote file editing needs a stronger permission shape than "the app is open."

Minimum model:

- explicit pairing flow per device ✓ shipped Phase 1.b
- repo/root allowlist on the PC ✓ slice 1 — daemon-global allowlist at `~/.push/run/pushd.allowlist`, managed via `push daemon allow|deny|allowlist`; enforced by `resolveAndAuthorize` in `cli/pushd-allowlist.ts` for every `sandbox_read_file`/`sandbox_write_file`/`sandbox_list_dir`/`sandbox_diff` and as a cwd gate for `sandbox_exec`. Empty file → implicit-cwd default; any explicit entry switches to strict "only listed roots" mode. Documented limitation: `sandbox_exec` commands can still touch any file the daemon process can reach — chroot/namespace isolation is out of scope.
- per-session attach token, separate from the deployment token ✓ slice 2 — `cli/pushd-attach-tokens.ts` mints short-lived (`PUSHD_ATTACH_TOKEN_TTL_MS`, default 24h sliding) device-attach tokens. WS upgrade accepts either kind (`pushd_da_*` prefix routed first, `pushd_*` device token as fallback). The web pairing flow calls `mint_device_attach_token` on the same WS that verified the device bearer, persists the attach token in IndexedDB, and discards the durable device token. `revoke_device_token` cascades: revoking the parent device kills every derived attach token AND closes its live WS connections. `daemon_identify` surfaces the parent device tokenId regardless of which kind authed the WS, so the attach tokenId never leaks. CLI: `push daemon attach-tokens` / `revoke-attach <tokenId>`.
- visible connected-device list in the desktop/daemon UI ✓ slice 1 — `push daemon devices` lists live WS connections per tokenId; pushd-ws tracks `connectionsByTokenId` and exposes `listConnectedDevices()`.
- approval prompts identify the requesting surface/device ✓ slice 4 — `LocalPcChatScreen` subscribes to the daemon's `approval_required` events via a new `useLocalDaemon({ onEvent })` callback and queues them into a FIFO. The `ApprovalPrompt` component (`app/src/components/local-pc/`) renders the head of the queue with Approve / Deny; clicking dispatches `submit_approval` over the same long-lived binding. `handleSubmitApproval` emits an `approval.decision` audit event with the device/attach-token provenance, so the audit log now records who approved or denied each pending gate. Closes the "delegated agents silently time out after 60s" gap.
- audit log includes `surface`, `deviceId`, `sessionId`, `runId`, repo path, command/tool, and approval decision ✓ slice 3 — `cli/pushd-audit-log.ts` writes NDJSON records to `~/.push/run/pushd.audit.log` (mode 0600). Schema: `{ v: 'push.audit.v1', ts, type, surface, deviceId?, attachTokenId?, authKind?, sessionId?, runId?, payload }`. Captured events: `auth.upgrade` / `auth.mint_attach` / `auth.revoke_device` / `auth.revoke_attach`, `tool.sandbox_exec` / `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_dir` / `sandbox_diff`, `delegate.coder` / `delegate.explorer` / `delegate.reviewer`, `session.start` / `session.cancel_run`. Most events are emitted via the dispatcher wrapper in `handleRequest` so handler bodies stay untouched; auth events emit at the source. **Privacy posture**: command text is OPT-IN via `PUSHD_AUDIT_LOG_COMMANDS=1` because shell commands routinely carry bearer tokens / API keys. The decision-doc field "command/tool" is interpreted structurally — tool name is always recorded; command text rides the env opt-in. Rotation: size-based, default 10MB threshold × 5 files (env: `PUSHD_AUDIT_MAX_BYTES`, `PUSHD_AUDIT_MAX_FILES`). Kill switch: `PUSHD_AUDIT_ENABLED=0`. Inspection: `push daemon audit [--tail N] [--since DATE] [--type TYPE] [--json]`.
- revoke device/session from the PC side ✓ slice 1 (live disconnect): `push daemon revoke <tokenId>` now routes through the daemon's Unix socket (with file-mutation fallback when offline). The handler mutates the tokens file AND calls `disconnectByTokenId(tokenId)` to close every WS bearing that token with close code 1008. Closes open question #6 below.

### Phase 4: Desktop Wrapper As Polish

Only after the daemon path exists, consider Tauri/Electron/Capacitor-for-desktop as a wrapper.

The wrapper's job is operational comfort:

- run `pushd` at login
- show relay status
- handle phone pairing
- open Push in a trusted local shell
- surface notifications for approvals and disconnects

It should not contain a separate agent loop.

## Non-Goals

- Public multi-user collaboration.
- Opening inbound ports on the user's computer.
- A direct browser-to-home-PC transport over the public internet.
- A desktop wrapper that becomes the runtime.
- Moving the existing production web app onto local execution as a hidden side effect.
- Letting the Worker relay run file tools, shell commands, or provider/model calls for remote sessions.

## Security Notes

The private deployment token added for self-hosted Cloudflare deployments is not the right primitive for remote sessions. It protects access to the hosted app/API origin. Remote sessions need device pairing and session attachment.

Recommended split:

- `PUSH_DEPLOYMENT_TOKEN`: optional site/API gate for a private Worker deployment.
- Remote device key: durable identity for a paired phone/browser.
- Session attach token: short-lived grant to attach a device to a specific `pushd` session.
- Approval token/state: per-tool pause/resume state owned by `pushd`.

The relay will still run on the user's Cloudflare account if they self-host the Worker there. That means it can add Worker/DO/WebSocket usage, but it should not add sandbox/container execution by itself. The PC remains the machine doing filesystem and command work.

Relay logging should be minimal. Protocol envelopes can contain file paths, command text, prompts, and model output. If durable replay is needed, store the smallest useful event window and make retention explicit.

## Open Questions

1. ~~Identity: Cloudflare Access, deployment token, pairing code, device keypair, or some layered combination?~~ **Answered (Phase 1)**: hashed device-token pairing with immutable origin binding at mint time. Tokens live in `~/.push/run/pushd.tokens` (chmod 0600), revocable by id. The phone/desktop client pastes the bearer once into the pairing panel; the daemon hashes-at-rest and compares on every upgrade. Deployment token + Cloudflare Access are still relevant for Phase 2's relay endpoint but not for client-to-daemon auth.
2. ~~Relay storage: Durable Object memory only, short event log in DO storage, KV/D1 index, or no durable replay in v1?~~ **Answered (2026-05-13, Phase 2 decision lock — 2.a; corrected post-review on the same day for the Hibernation/cursor gaps)**: DO in-memory ring buffer per session; no durable storage. The reliability of in-memory state hinges on the DO instance staying loaded for the WebSocket's lifetime, so **2.b deliberately does NOT use the WebSocket Hibernation API** — hibernation can unload DO memory while the WS stays open, which would silently invalidate the buffer mid-session. Plain WebSockets keep the DO instance pinned to memory for as long as `pushd`'s outbound WS is connected; the trade-off is higher idle DO billing per connected session, accepted because remote-session DOs are inherently per-user and short-lived. The buffer is bounded by both count (default `N=256` envelopes) and age (default `Y=60s`); the first cap to fire evicts. After auth the phone client sends an initial `attach` envelope carrying its last-seen `seq` (browser `WebSocket` can't set custom upgrade headers — same constraint that put the Phase 1 bearer in `Sec-WebSocket-Protocol`); the relay replays from `seq+1` if still buffered; a gap larger than the buffer emits a `replay_unavailable` event so the client falls back to `attach_session` for current state rather than silently missing envelopes. No envelope content (file paths, command text, model output) lands in durable storage — keeps the "smallest useful event window" literal from the Security Notes. KV/D1 deferred; revisit if Phase 4 desktop wrapper needs cross-session listing or if real-world telemetry shows reattach holes. Implementation tracked in the Phase 2 sub-phase table above (2.d).
3. ~~Protocol validation: move `cli/protocol-schema.ts` into `lib/` in Phase 1, or wait until web/mobile consumes the daemon protocol directly?~~ **Answered (PR #508)**: moved into `lib/protocol-schema.ts` during Phase 1 because the web adapter consumes it directly. `cli/session-store.ts` re-exports for back-compat. The `cli/tests/protocol-schema-canonical.test.mjs` drift guard scans `app/src/` for duplicate version literals or validator re-defs.
4. ~~Local connector transport: browser-to-localhost WebSocket, native wrapper bridge, or both?~~ **Answered**: browser-to-localhost WebSocket. The browser's `WebSocket` constructor can't set arbitrary headers, so the bearer travels in `Sec-WebSocket-Protocol`. Native wrapper bridge is not on the current roadmap — Phase 4 desktop wrapper would still tunnel through the same WS, not introduce a parallel transport.
5. ~~Workspace Hub UX: how does a user distinguish cloud sandbox workspaces from local-PC remote sessions?~~ **Answered (PR #510)**: dedicated "Local PC · Experimental" tile in both Onboarding and Hub (flag-gated by `VITE_LOCAL_PC_MODE`); paired workspace renders an always-visible amber `LocalPcModeChip` showing `Local PC · :<port> · <status>` in the header. Cloud sessions render no chip — absence is the affordance.
6. ~~Revocation: what is the exact PC-side UX for "kick this phone off now"?~~ **Answered (Phase 3 slice 1)**: `push daemon revoke <tokenId>` now routes through the daemon's Unix socket. The handler mutates the tokens file AND closes every live WS bearing that tokenId with close code 1008. The CLI prints the number of live connections closed (`revoked pdt_... (closed 2 live connections)`). If the daemon isn't running, the CLI falls back to direct file mutation — there's no live connection to kill anyway. Web side still clears the IndexedDB record on the browser's "Unpair" button.
7. Network failure: how much local daemon work can continue when the phone disconnects? **Still open** — depends on Phase 1.d's chat-layer wiring (3c.2) shipping first.
8. Diff/review payload shape across the relay: when a phone surface attaches to a remote `pushd` daemon and Reviewer/Auditor/Coder emit diff + annotations, what envelope rides the relay? **Tracked separately** in `docs/decisions/Diff and Annotation Envelope.md` (Draft, 2026-05-12). The decision there is to hand-roll the envelope in `lib/` and treat `@pierre/diffs` and `modem-dev/hunk` as design references only; this keeps remote sessions on `push.runtime.v1` without inventing a parallel vocabulary for review payloads.

## Implementation Rules

- Extend `push.runtime.v1`; do not invent a second remote-session vocabulary.
- Keep the Worker relay dumb. It forwards, authenticates, and buffers. It does not execute tools.
- Keep shell concerns out of `lib/`; only graduate protocol/schema code when both shells consume it.
- Add drift-detector tests when web/mobile starts consuming daemon envelopes.
- Include device/surface provenance in approvals before remote write/exec support is enabled.
- Treat this as an explicit product mode. Do not quietly redirect existing web chats to a local daemon.
