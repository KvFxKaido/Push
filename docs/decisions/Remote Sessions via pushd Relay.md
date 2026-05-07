# Remote Sessions via pushd Relay

Date: 2026-05-07
Status: Draft
Owner: Push
Related: `docs/cli/design/Push Runtime Protocol.md`, `docs/decisions/Web and CLI Runtime Contract.md`, `docs/decisions/push-runtime-v2.md`

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

- start or discover a local daemon
- pair a client
- attach to a session
- stream events
- submit approvals
- cancel/reconnect
- edit files through the existing local tool surface

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

- explicit pairing flow per device
- repo/root allowlist on the PC
- per-session attach token, separate from the deployment token
- visible connected-device list in the desktop/daemon UI
- approval prompts identify the requesting surface/device
- audit log includes `surface`, `deviceId`, `sessionId`, `runId`, repo path, command/tool, and approval decision
- revoke device/session from the PC side

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

1. Identity: Cloudflare Access, deployment token, pairing code, device keypair, or some layered combination?
2. Relay storage: Durable Object memory only, short event log in DO storage, KV/D1 index, or no durable replay in v1?
3. Protocol validation: move `cli/protocol-schema.ts` into `lib/` in Phase 1, or wait until web/mobile consumes the daemon protocol directly?
4. Local connector transport: browser-to-localhost WebSocket, native wrapper bridge, or both?
5. Workspace Hub UX: how does a user distinguish cloud sandbox workspaces from local-PC remote sessions?
6. Revocation: what is the exact PC-side UX for "kick this phone off now"?
7. Network failure: how much local daemon work can continue when the phone disconnects?

## Implementation Rules

- Extend `push.runtime.v1`; do not invent a second remote-session vocabulary.
- Keep the Worker relay dumb. It forwards, authenticates, and buffers. It does not execute tools.
- Keep shell concerns out of `lib/`; only graduate protocol/schema code when both shells consume it.
- Add drift-detector tests when web/mobile starts consuming daemon envelopes.
- Include device/surface provenance in approvals before remote write/exec support is enabled.
- Treat this as an explicit product mode. Do not quietly redirect existing web chats to a local daemon.
