# Push Runtime Protocol (MVP)

Date: 2026-02-19  
Status: Draft  
Owner: Push

## Purpose

Define the protocol between Push clients (`push` TUI, `push run --headless`, future app remote client) and the runtime daemon (`pushd`).

This protocol is interactive-first and supports:
- streaming model output
- tool-call visibility
- approval gates
- cancellation and resume
- reconnect + event replay

## Product Alignment

This protocol follows the current CLI direction in `documents/Push CLI Plan.md`:
- interactive UX is default
- headless is optional mode
- modal is optional via sandbox provider abstraction

## Schema Artifacts

Concrete JSON Schemas for this protocol live in `documents/schemas/`:
- `documents/schemas/push-runtime-envelope.schema.json` (entrypoint)
- `documents/schemas/push-runtime-request-envelope.schema.json`
- `documents/schemas/push-runtime-response-envelope.schema.json`
- `documents/schemas/push-runtime-event-envelope.schema.json`
- `documents/schemas/push-runtime-defs.schema.json`

## Non-Goals (MVP)

- cross-machine multi-user collaboration
- full backward compatibility across major protocol versions
- perfect card parity across all clients
- binary transport optimization

## Terminology

- `runtime`: `pushd`
- `client`: `push` CLI, `push run --headless`, or app remote UI
- `session`: long-lived conversation/workspace context
- `run`: one user-triggered execution cycle inside a session
- `approval`: runtime pause that requires user decision before continuing

## Protocol Versioning

Protocol version string:
- `push.runtime.v1`

Rules:
1. Every message includes `v`.
2. Unknown event types must be ignored (forward-compatible clients).
3. Unknown request types return `UNSUPPORTED_REQUEST_TYPE`.
4. Breaking changes require `v2`.

## Transport

Primary (local):
- Unix: domain socket, recommended path `~/.push/run/pushd.sock`
- Windows: named pipe equivalent

Secondary (remote app bridge):
- WebSocket endpoint that forwards the same JSON envelopes unchanged

Message framing:
- UTF-8 NDJSON (one JSON object per line)

## Envelope Types

All messages are one of:
- `request`
- `response`
- `event`

### Request Envelope

```json
{
  "v": "push.runtime.v1",
  "kind": "request",
  "requestId": "req_01HXYZ...",
  "type": "send_user_message",
  "sessionId": "sess_01HXYZ...",
  "payload": {}
}
```

### Response Envelope

```json
{
  "v": "push.runtime.v1",
  "kind": "response",
  "requestId": "req_01HXYZ...",
  "type": "send_user_message",
  "sessionId": "sess_01HXYZ...",
  "ok": true,
  "payload": {},
  "error": null
}
```

### Event Envelope

```json
{
  "v": "push.runtime.v1",
  "kind": "event",
  "sessionId": "sess_01HXYZ...",
  "runId": "run_01HXYZ...",
  "seq": 42,
  "ts": 1760000000000,
  "type": "tool_call",
  "payload": {}
}
```

Event ordering:
- `seq` is strictly monotonic per session.
- clients must dedupe by `(sessionId, seq)`.

## Core Data Types

### ProtocolError

```ts
interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}
```

### SessionState

```ts
type SessionState =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

### RunOutcome

```ts
type RunOutcome = 'success' | 'failed' | 'cancelled' | 'denied';
```

### ApprovalDecision

```ts
type ApprovalDecision = 'approve' | 'deny';
```

## Request/Response Contract

## `hello`

Purpose:
- handshake + capability negotiation

Request payload:

```json
{
  "clientName": "push",
  "clientVersion": "0.1.0",
  "capabilities": ["stream_tokens", "approvals", "replay_attach"]
}
```

Response payload:

```json
{
  "runtimeName": "pushd",
  "runtimeVersion": "0.1.0",
  "protocolVersion": "push.runtime.v1",
  "capabilities": ["stream_tokens", "approvals", "replay_attach", "headless"]
}
```

## `start_session`

Purpose:
- create a new session

Request payload:

```json
{
  "mode": "interactive",
  "provider": "ollama",
  "sandboxProvider": "local",
  "repo": {
    "rootPath": "/home/user/projects/Push",
    "remoteUrl": "git@github.com:owner/repo.git",
    "currentBranch": "main",
    "defaultBranch": "main"
  },
  "metadata": {
    "source": "cli"
  }
}
```

Response payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "state": "idle",
  "attachToken": "att_..."
}
```

Notes:
- `attachToken` is for optional secondary client attachment.

## `list_sessions`

Purpose:
- discover resumable sessions

Request payload:

```json
{
  "limit": 20
}
```

Response payload:

```json
{
  "sessions": [
    {
      "sessionId": "sess_01HXYZ...",
      "state": "idle",
      "updatedAt": 1760000000000,
      "repo": {
        "rootPath": "/home/user/projects/Push",
        "currentBranch": "main"
      }
    }
  ]
}
```

## `attach_session`

Purpose:
- attach to an existing session and optionally replay missed events

Request payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "lastSeenSeq": 135,
  "attachToken": "att_..."
}
```

Response payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "state": "running",
  "replay": {
    "fromSeq": 136,
    "toSeq": 149,
    "completed": true,
    "gap": false
  }
}
```

Gap behavior:
- if replay buffer cannot satisfy `lastSeenSeq`, runtime returns `gap: true` and emits a `session_snapshot` event.

## `resume_session`

Purpose:
- convenience alias for attach + state summary (CLI UX)

Request payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "lastSeenSeq": 0
}
```

Response payload:
- same shape as `attach_session`

## `send_user_message`

Purpose:
- start a run from user input

Request payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "clientMessageId": "msg_01HXYZ...",
  "text": "Review the latest commit and suggest fixes.",
  "acceptanceCriteria": [
    {
      "id": "build",
      "check": "npm -C app run build",
      "exitCode": 0,
      "description": "App builds"
    }
  ]
}
```

Response payload:

```json
{
  "runId": "run_01HXYZ...",
  "accepted": true
}
```

Idempotency:
- runtime must dedupe duplicate `clientMessageId` within the same session.

## `submit_approval`

Purpose:
- respond to an `approval_required` pause

Request payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "runId": "run_01HXYZ...",
  "approvalId": "appr_01HXYZ...",
  "decision": "approve",
  "comment": "Looks good"
}
```

Response payload:

```json
{
  "accepted": true
}
```

## `cancel_run`

Purpose:
- stop active run

Request payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "runId": "run_01HXYZ...",
  "reason": "user_cancelled"
}
```

Response payload:

```json
{
  "accepted": true
}
```

## `ping`

Purpose:
- health check

Request payload:

```json
{}
```

Response payload:

```json
{
  "pong": true,
  "ts": 1760000000000
}
```

## Event Catalog

## `session_started`

Emitted when session is created.

Payload:

```json
{
  "sessionId": "sess_01HXYZ...",
  "state": "idle",
  "mode": "interactive",
  "provider": "ollama",
  "sandboxProvider": "local"
}
```

## `session_snapshot`

Emitted on replay gap or explicit attach summary.

Payload:

```json
{
  "state": "running",
  "activeRunId": "run_01HXYZ...",
  "lastAssistantText": "...",
  "pendingApproval": null,
  "meta": {
    "provider": "ollama",
    "sandboxProvider": "local"
  }
}
```

## `status`

Payload:

```json
{
  "source": "orchestrator",
  "phase": "Executing tool...",
  "detail": "sandbox_read_file"
}
```

## `thinking_token`

Payload:

```json
{
  "text": "Need to inspect recent commit..."
}
```

## `assistant_token`

Payload:

```json
{
  "text": "I reviewed the commit and found..."
}
```

## `assistant_done`

Payload:

```json
{
  "messageId": "asst_01HXYZ..."
}
```

## `tool_call`

Payload:

```json
{
  "source": "sandbox",
  "toolName": "sandbox_read_file",
  "args": {
    "path": "app/src/hooks/useChat.ts"
  }
}
```

## `tool_result`

Payload:

```json
{
  "source": "sandbox",
  "toolName": "sandbox_read_file",
  "durationMs": 124,
  "isError": false,
  "text": "[Tool Result — sandbox_read_file] ...",
  "structuredError": null
}
```

`structuredError` follows existing app taxonomy when present:
- `type`
- `retryable`
- `message`
- `detail?`

## `approval_required`

Payload:

```json
{
  "approvalId": "appr_01HXYZ...",
  "kind": "commit",
  "title": "Approve commit",
  "summary": "feat: improve tool-call parsing",
  "details": {
    "filesChanged": 4,
    "insertions": 120,
    "deletions": 40
  },
  "options": ["approve", "deny"],
  "expiresAt": 1760000300000
}
```

## `approval_received`

Payload:

```json
{
  "approvalId": "appr_01HXYZ...",
  "decision": "approve",
  "by": "cli"
}
```

## `warning`

Payload:

```json
{
  "code": "EVENT_GAP",
  "message": "Replay gap detected; snapshot sent.",
  "detail": "Requested lastSeenSeq=120 but earliest retained seq is 140"
}
```

## `error`

Payload:

```json
{
  "code": "SANDBOX_UNAVAILABLE",
  "message": "Sandbox provider failed to start workspace.",
  "retryable": true,
  "detail": "modal endpoint timeout"
}
```

## `run_complete`

Payload:

```json
{
  "runId": "run_01HXYZ...",
  "outcome": "success",
  "summary": "Implemented fix and verified build passes.",
  "acceptance": {
    "total": 1,
    "passed": 1,
    "results": [
      {
        "id": "build",
        "passed": true,
        "exitCode": 0,
        "output": ""
      }
    ]
  },
  "headless": {
    "exitCodeHint": 0
  }
}
```

## Error Codes (Protocol Layer)

These codes are for request/response and runtime control flow, not tool internals.

- `UNSUPPORTED_PROTOCOL_VERSION`
- `UNSUPPORTED_REQUEST_TYPE`
- `INVALID_REQUEST`
- `SESSION_NOT_FOUND`
- `ATTACH_FORBIDDEN`
- `RUN_IN_PROGRESS`
- `NO_ACTIVE_RUN`
- `APPROVAL_NOT_FOUND`
- `APPROVAL_EXPIRED`
- `PROVIDER_NOT_CONFIGURED`
- `SANDBOX_UNAVAILABLE`
- `INTERNAL_ERROR`

## Replay and Reconnect Semantics

1. Runtime buffers recent events per session (configurable retention).
2. Client sends `lastSeenSeq` on attach.
3. Runtime replays events with `seq > lastSeenSeq` when available.
4. If unavailable, runtime emits:
- `warning` with `EVENT_GAP`
- `session_snapshot`
5. Client should treat snapshot as fresh baseline.

Delivery guarantee (MVP):
- at-least-once event delivery
- ordering preserved by `seq`

## Concurrency Rules

Session-level:
- one active run per session
- multiple clients may attach as observers

Approval-level:
- first valid `submit_approval` wins
- subsequent approval submissions return `APPROVAL_EXPIRED` or `APPROVAL_NOT_FOUND`

## Headless Mode Semantics

`push run --headless` still uses the same protocol/events, but client behavior differs:
- no interactive approval prompt unless explicitly allowed
- optional `--json` final output derived from `run_complete`
- process exit code maps from `run_complete.headless.exitCodeHint`

Recommended exit mapping:
- `0`: success
- `1`: failed (runtime/tool/system)
- `2`: cancelled by user
- `3`: denied approval
- `4`: acceptance criteria failed

## Security Requirements

1. Local IPC endpoint must be owner-only.
- Unix socket path permissions should be restricted.

2. Attach control.
- `attachToken` required for secondary client attach unless same owner process policy allows trusted attach.

3. Secret redaction.
- runtime must redact tokens and credentials from emitted events/logs.

4. Approval provenance.
- `approval_received` includes source (`cli`, `app`, etc.) for auditability.

## Minimal Contract Tests (Phase 0)

1. Handshake
- `hello` request/response validates version and capabilities.

2. Session start
- `start_session` returns `sessionId` and emits `session_started`.

3. Streaming
- `send_user_message` emits ordered `assistant_token` events then `run_complete`.

4. Tool visibility
- run emits `tool_call` + `tool_result` with matching `toolName`.

5. Approval path
- `approval_required` pause + `submit_approval` resume path works.

6. Cancel path
- `cancel_run` emits `run_complete` with `outcome=cancelled`.

7. Replay attach
- attach with `lastSeenSeq` replays missing events in order.

## Example Flow (Interactive, With Approval)

1. Client sends `hello`.
2. Client sends `start_session`.
3. Runtime emits `session_started`.
4. Client sends `send_user_message`.
5. Runtime emits `status`, `assistant_token`, `tool_call`, `tool_result`...
6. Runtime emits `approval_required`.
7. Client sends `submit_approval(decision=approve)`.
8. Runtime emits `approval_received`.
9. Runtime continues tool loop and emits `run_complete`.

## Open Follow-Ups

1. Decide default event retention depth/time for replay.
2. Decide whether app remote bridge is direct WebSocket or worker-mediated relay.
