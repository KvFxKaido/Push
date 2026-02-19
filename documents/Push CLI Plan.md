# Push CLI Plan (V2)

Date: 2026-02-19  
Status: Draft  
Owner: Push

## Decision

Push CLI is an interactive product first, not a headless tool first.

Default experience:
- Codex/Claude Code style interactive terminal UX

Optional mode:
- Headless non-interactive execution for CI and automation

Platform direction:
- The same runtime powers CLI, web, and Android remote clients
- Modal is an option, not a hard dependency

## Product Principles

1. Interactive by default
- `push` launches a full TUI session with streaming, tool timeline, diffs, approvals, interrupt/resume, and checkpoints.

2. One engine, multiple clients
- CLI, web, and Android are clients of the same runtime protocol.
- No duplicate orchestration logic per client.

3. Headless is a mode, not a fork
- `push run --headless` uses the same core runtime and tools.
- Headless changes IO behavior only.

4. Modal optional
- Sandbox provider is pluggable.
- Local execution provider is first-class, Modal provider remains supported.

## User Experience Targets

### Interactive (`push`)

Expected baseline:
- Streaming answer tokens
- Live tool-call timeline
- Structured tool result cards rendered in terminal form
- Diff preview before write/commit actions
- Confirmation gates for destructive actions
- Keyboard controls for interrupt, approve, retry, and inspect
- Session resume by id

### Headless (`push run --headless`)

Expected baseline:
- Deterministic non-interactive run
- JSON output option for scripts/CI
- Exit codes tied to task success/failure and acceptance checks

### Remote Attach (`push remote` and app integration)

Expected baseline:
- Attach to an existing local runtime session
- Read stream + send user inputs/tool approvals
- Handles disconnect/reconnect without losing job state

## Scope and Non-Goals

In scope (MVP):
- Interactive TUI experience
- Runtime daemon process (`pushd`)
- Session protocol for clients
- Local sandbox provider + Modal sandbox provider
- CLI client using runtime protocol

Out of scope (MVP):
- Full cross-platform GUI rewrite
- Complex plugin marketplace
- Multi-user shared sessions
- Perfect feature parity with all existing app cards on day one

## Architecture

## High-Level Model

Components:
- `push` (CLI client, interactive)
- `push run --headless` (CLI client, non-interactive)
- `pushd` (runtime daemon)
- `app` remote client (future phase)
- Providers behind interfaces:
  - AI provider (`moonshot`, `ollama`, `mistral`, `zai`, `minimax`, `openrouter`)
  - Sandbox provider (`local`, `modal`)

Flow:
1. Client opens/attaches session in `pushd`
2. Client sends user input event
3. Runtime executes orchestrator/tool loop
4. Runtime emits streaming events to subscribers
5. Client renders events (TUI/app)

## Runtime Responsibilities (`pushd`)

- Session lifecycle and persistence metadata
- Agent loop execution and cancellation
- Tool dispatch and capability gating
- Provider selection and fallback
- Workspace state tracking
- Acceptance criteria execution
- Event broadcasting to one or more clients

## Client Responsibilities (`push` / app)

- Render stream/events
- Collect user input and confirmations
- Display cards/diffs in client-native UI
- Keep minimal local state; runtime is source of truth

## Protocol (MVP)

Transport options:
- Local IPC for CLI to daemon (Unix socket or named pipe)
- WebSocket/SSE adapter for remote app attach

Core event envelope:

```json
{
  "sessionId": "sess_123",
  "seq": 42,
  "ts": 1760000000000,
  "type": "tool_call",
  "payload": {"tool": "sandbox_read_file", "args": {"path": "app/src/lib/orchestrator.ts"}}
}
```

Event types (initial):
- `session_started`
- `assistant_token`
- `assistant_done`
- `thinking_token` (optional per provider)
- `tool_call`
- `tool_result`
- `approval_required`
- `approval_received`
- `status`
- `warning`
- `error`
- `run_complete`

Control messages (client to runtime):
- `start_session`
- `send_user_message`
- `approve`
- `deny`
- `cancel_run`
- `resume_session`
- `attach_session`

## Provider Interfaces

### AI Provider

Contract:

```ts
interface AIProvider {
  id: 'moonshot' | 'ollama' | 'mistral' | 'zai' | 'minimax' | 'openrouter';
  streamChat(req: StreamRequest): AsyncIterable<ProviderChunk>;
}
```

### Sandbox Provider

Contract:

```ts
interface SandboxProvider {
  id: 'local' | 'modal';
  createWorkspace(input: WorkspaceInput): Promise<WorkspaceHandle>;
  exec(handle: WorkspaceHandle, command: string, opts?: ExecOpts): Promise<ExecResult>;
  readFile(handle: WorkspaceHandle, path: string, range?: LineRange): Promise<FileReadResult>;
  writeFile(handle: WorkspaceHandle, path: string, content: string, expectedVersion?: string): Promise<WriteResult>;
  diff(handle: WorkspaceHandle): Promise<DiffResult>;
  cleanup(handle: WorkspaceHandle): Promise<void>;
}
```

Rule:
- All tool behavior goes through the active sandbox provider.
- Tool protocol remains stable; provider-specific behavior is hidden behind adapters.

## Execution Modes

Mode selection:
- Default: interactive TUI with local provider preferred
- Optional: `--sandbox modal`
- Optional: `--headless`

Example commands:
- `push` (interactive session)
- `push chat "review recent commit"`
- `push run --headless --task "fix failing tests" --json`
- `push --sandbox modal`
- `push remote attach <session-id>`

## Security Model

- Store tokens in OS keychain/credential store when possible
- Fallback encrypted-at-rest file config only if keychain unavailable
- Never echo secrets in event stream
- Redact tokens from tool outputs and logs
- Explicit approval gates for destructive ops

## Incremental Implementation Plan

Phase 0: Runtime Contract and Skeleton (3-5 days)
- Define event protocol and message schemas
- Add `pushd` skeleton with session manager
- Add local IPC path and a minimal `push` client

Deliverable:
- `push` can start a session and print streamed assistant text from runtime mock

Phase 1: Interactive TUI MVP (1-2 weeks)
- Build terminal UI loop (input, stream output, status bar, tool timeline)
- Add interrupt/cancel and resume support
- Render basic tool results and errors

Deliverable:
- Codex/Claude-style interactive experience without full card parity

Phase 2: Real Agent Integration (1 week)
- Connect runtime to existing orchestrator/tool dispatch logic
- Wire provider config and key loading
- Preserve current behavior for tool loop semantics

Deliverable:
- End-to-end agent task execution in interactive CLI

Phase 3: Sandbox Provider Abstraction (1-2 weeks)
- Introduce `SandboxProvider` interface
- Implement `modal` adapter from existing sandbox client behavior
- Implement `local` adapter (workspace-local exec/read/write/diff)
- Capability checks surfaced as clear runtime warnings

Deliverable:
- Modal no longer required for local execution flows

Phase 4: Headless Mode (3-5 days)
- Add `push run --headless`
- Add machine-readable JSON output and strict exit codes

Deliverable:
- CI-friendly non-interactive execution on same engine

Phase 5: Remote Client Support (1-2 weeks)
- Add attach/read/write runtime endpoints for app client
- Add reconnect and session ownership safeguards

Deliverable:
- App can attach to local runtime session as remote UI

## Migration Strategy from Current Code

1. Do not start with a large `core/` directory move.
2. First create runtime boundary and protocol in-place.
3. Extract modules only when shared by at least two clients and stable.
4. Keep app behavior unchanged while runtime path matures.

Rationale:
- Reduces early churn and import breakage risk
- Validates architecture before structural refactor

## Risks and Mitigations

Risk: Runtime protocol churn breaks clients  
Mitigation:
- Versioned protocol messages and compatibility checks

Risk: Local provider behavior diverges from Modal  
Mitigation:
- Shared tool-level contract tests against both providers

Risk: TUI quality misses interactive expectation  
Mitigation:
- Prioritize session UX loops before expanding command surface

Risk: Secret leakage in logs/events  
Mitigation:
- Centralized redaction and log-level controls in runtime

## Success Criteria

- `push` interactive session feels production-usable for daily coding tasks
- Tool loop is visible and interruptible
- `push run --headless` works with stable JSON and exit codes
- Same runtime session can be attached by another client
- Local sandbox provider handles primary workflows without Modal
- Modal remains available as optional provider

## Open Decisions

1. IPC transport choice for local attach
- Unix socket first is recommended; add TCP/WebSocket adapter later

2. Session persistence depth
- Recommended: persist metadata and checkpoints, not full token stream

3. Local provider isolation model
- Recommended: workspace-scoped process sandboxing first, container isolation later

## Immediate Next Actions

1. Create `documents/Push Runtime Protocol.md` with schema and event examples.
2. Scaffold `cli/` with two processes: `push` client and `pushd` runtime.
3. Implement Phase 0 end-to-end with mocked provider stream.
4. Implement Phase 1 interactive TUI controls before adding more commands.
