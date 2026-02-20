# Push CLI Bootstrap Execution Plan

Date: 2026-02-20  
Status: Completed  
Owner: Push

## Goal

Take the bootstrap CLI from "works" to a safer daily driver, without blocking on a full daemon rewrite.

Primary outcome:
- Keep interactive-first behavior.
- Keep headless as an IO mode on the same engine.
- Ship a clean handoff point for `pushd`.

## Execution Outcome

All planned workstreams shipped in this sprint.

## W1: Safety and Reliability Hardening (Shipped)

- Added high-risk command detection for 20 command patterns in `exec`.
- Added interactive approval gate for high-risk `exec` operations.
- Added headless auto-deny for high-risk `exec` calls without approval support.
- Added provider retry policy with exponential backoff (`MAX_RETRIES = 3`).
- Added deterministic loop guards for repeated identical tool calls (3 repeats) and max-rounds outcome classification.
- Improved truncation signals with character and line-count metadata.

## W2: Protocol-Shape Alignment (Shipped)

- Session events now persist a protocol-aligned envelope: `v`, `kind`, `sessionId`, `seq`, `ts`, optional `runId`.
- Normalized tool payload keys for event consumers: `toolName`, `source`, `isError`.
- Added stable JSON outputs in `push run --json` and `push sessions --json`.
- Added run-level tracking with persisted `runId` on run-scoped events.

## W3: Code Structure and Testability (Shipped)

- Split the monolith into `scripts/push/cli.mjs`, `scripts/push/engine.mjs`, `scripts/push/tools.mjs`, `scripts/push/session-store.mjs`, and `scripts/push/provider.mjs`.
- Updated root launcher `push` to execute `scripts/push/cli.mjs`.
- Retired legacy monolith `scripts/push.mjs`.
- Added tests under `scripts/push/tests/`: 34 `node:test` cases covering tool-call parser (8), workspace path guard (8), high-risk detection (10), truncation behavior (2), and session persistence/protocol serialization (6).

## W4: `pushd` Skeleton (Shipped)

- Added daemon entrypoint: `scripts/pushd.mjs`.
- Added Unix socket transport with NDJSON request/response framing.
- Added owner-only socket permissions (`0600`).
- Implemented request types: `hello`, `start_session`, `send_user_message`, and `attach_session`.
- Reused the same engine/session modules as CLI (no duplicate orchestration loop).

## Still Out of Scope

- Full-screen TUI (dropped direction).
- Full app-side remote attach UX.
- Complete web-card/modal parity for daemon mode.

## Follow-up Candidates

1. Add optional schema validation mode against `documents/schemas/*` for protocol events.
2. Add integration tests for end-to-end daemon request flows.
3. Add explicit CLI client commands for daemon attach and event streaming.
