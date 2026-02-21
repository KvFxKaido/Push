# Push CLI TUI Phase 1 Plan

Date: 2026-02-21  
Status: Proposed  
Owner: Push

## Decision Summary

- Ship an optional full-screen terminal UI as `push tui`.
- Keep `push` (line-oriented REPL) as the default and supported path.
- Reuse existing runtime engine and `push.runtime.v1` protocol. No orchestration fork.
- Keep scope intentionally thin: transcript, tool timeline, approvals, status, and input.

## Why Now

- CLI engine/tooling is mostly stable and already supports streaming, approvals, sessions, and headless runs.
- Existing `pushd` NDJSON protocol already defines nearly all events the TUI needs.
- A TUI can improve scanability and control on long runs without changing core behavior.

## Phase 1 Goals

- Make long interactive runs easier to follow than the current transcript-only REPL.
- Keep cancellation/approval actions one keypress away.
- Preserve deterministic behavior with existing CLI mode and tests.
- Add no required backend protocol version bump.

## Phase 1 Non-Goals

- No card-level parity with the web app.
- No multi-user collaboration.
- No plugin system.
- No replacement of the current interactive REPL.
- No protocol `v2` rollout unless a hard blocker appears.

## UX Scope

## Command Surface

- `push tui`
- `push tui --session <id>`
- `push tui --provider <name> --model <name>` (same config precedence rules as current CLI)

## Layout (Single Screen)

- Header bar: provider, model, session id, branch, run state.
- Main transcript pane: assistant/user text stream in chronological order.
- Tool pane (toggle): recent tool calls/results with error highlighting.
- Composer pane: editable input with send/cancel behavior.
- Footer hint bar: active keybinds and approval state.

## Core Interactions

- Start/attach session, send message, stream tokens in place.
- Show live tool activity and completion timing.
- Pause for `approval_required`; allow approve/deny with explicit confirmation key.
- Cancel active run and keep session intact.
- Persist/restore UI state on resize and re-attach.

## Keybinds (Phase 1)

| Key | Action |
|---|---|
| `Enter` | Send composer message |
| `Shift+Enter` | New line in composer |
| `Ctrl+C` | Cancel active run; if idle, prompt exit |
| `Ctrl+T` | Toggle tool pane |
| `Ctrl+L` | Clear viewport (not session history) |
| `Ctrl+R` | Re-attach/replay current session |
| `Ctrl+Y` | Approve current approval prompt |
| `Ctrl+N` | Deny current approval prompt |
| `Ctrl+P` | Open quick provider/model switcher |
| `Esc` | Close modal/prompt |

## Runtime/Event Contract (Phase 1)

The TUI consumes existing `push.runtime.v1` events:

- `session_started`
- `session_snapshot`
- `status`
- `thinking_token`
- `assistant_token`
- `assistant_done`
- `tool_call`
- `tool_result`
- `approval_required`
- `approval_received`
- `warning`
- `error`
- `run_complete`

Client requests used:

- `hello`
- `start_session`
- `attach_session`
- `resume_session`
- `send_user_message`
- `submit_approval`
- `cancel_run`
- `ping`

Phase 1 protocol rule:

- No required schema changes.
- TUI must tolerate unknown event types and unknown payload fields.
- Event dedupe key remains `(sessionId, seq)`.

## Implementation Slices

1. Shell and transport
- Add `tui.mjs` entrypoint and command routing in `cli/cli.mjs`.
- Connect to `pushd` via existing NDJSON request/response/event envelopes.
- Add reconnect path using `attach_session` + replay.

2. Rendering primitives
- Build panes: header, transcript, tool feed, composer, footer.
- Implement token streaming append and smooth scroll behavior.
- Add minimal theming and terminal resize handling.

3. Controls and approvals
- Wire keybinds to runtime requests.
- Add approval modal with explicit approve/deny actions.
- Add cancel-run flow with visible run-state transition.

4. Reliability and tests
- Add focused integration tests for TUI event handling and key actions.
- Add golden-style snapshot tests for high-volume stream rendering.
- Keep existing CLI REPL tests unchanged; TUI tests run as separate suite.

## Exit Criteria

- Can complete end-to-end task from `push tui` with streaming and tool visibility.
- Approval-required run can be approved/denied without leaving TUI.
- Canceling a run does not corrupt session state.
- Re-attach after disconnect resumes with replay and no duplicate transcript lines.
- No regression in existing `push` interactive mode behavior.

## Risks and Mitigations

- Risk: Terminal rendering edge cases across environments.
- Mitigation: Keep Phase 1 layout simple and avoid exotic widgets.

- Risk: Event flood causes UI lag on long tool outputs.
- Mitigation: Windowed rendering and bounded in-memory transcript chunks.

- Risk: Divergence from REPL behavior.
- Mitigation: Shared runtime protocol and shared command handlers for approvals/cancel.

## Rollout

- Feature flag: `PUSH_TUI_ENABLED=1` for initial rollout.
- Early adopter command path only: `push tui`.
- Promote after one cycle of dogfooding and zero high-severity regressions.
