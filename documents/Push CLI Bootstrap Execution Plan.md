# Push CLI Bootstrap Execution Plan

Date: 2026-02-20  
Status: Draft  
Owner: Push

## Goal

Take the shipped bootstrap CLI (`push` + `scripts/push.mjs`) from "works" to "safe daily driver" without stalling on a full daemon rewrite.

Primary outcome:
- Keep interactive-first behavior.
- Keep headless as an IO mode on the same engine.
- Prepare a clean handoff point for `pushd`.

## Current Baseline

Shipped in `feat(cli): bootstrap push interactive/headless command` (`dd496be`):

- `push` launcher script at repo root.
- Interactive session mode: `push`
- Headless mode: `push run --task "..."`
- Session listing: `push sessions`
- Session persistence in `.push/sessions/<sessionId>/`
  - `state.json`
  - `events.jsonl`
- Local tool loop with:
  - `read_file`
  - `list_dir`
  - `search_files`
  - `exec`
  - `write_file`

Known gaps:
- no explicit approval gates for risky operations
- no stable runtime-protocol envelope in saved events
- no automated tests for parser/tool guards
- monolithic `scripts/push.mjs` (needs modularization)
- no daemon/attach path yet

## Scope (This Plan)

In:
- safety hardening
- protocol alignment (on-disk events + CLI JSON shape)
- modularization + tests
- `pushd` skeleton with minimal request surface

Out:
- full-screen TUI
- full app remote attach
- complete modal parity
- all card parity from web app

## Workstreams

## W1: Safety and Reliability Hardening

Tasks:
- Add interactive approval gates for dangerous operations.
  - `exec`: commands containing high-risk verbs (`rm`, `git reset --hard`, `git clean -fd`, etc.) require explicit confirmation.
  - `write_file`: optionally gate writes outside user-provided allow-paths (or always gate in strict mode).
- Add retry policy for provider networking failures (bounded retries + backoff).
- Improve loop guards:
  - repeated identical tool-call cutoff
  - explicit `max_rounds` outcome classification
- Improve output truncation signals so the model can react cleanly.

Acceptance criteria:
- destructive command attempts are never executed silently in interactive mode
- provider transient failures retry with bounded policy
- infinite-loop behavior is capped deterministically with clear error text

## W2: Protocol-Shape Alignment

Tasks:
- Align `.push/sessions/*/events.jsonl` with a strict subset of `documents/Push Runtime Protocol.md`:
  - include version field
  - include session/run identifiers
  - normalize event names and payload keys
- Add stable JSON output contracts:
  - `push run --json`
  - `push sessions --json`
- Add schema validation option (dev flag) against `documents/schemas/*`.

Acceptance criteria:
- replay tooling can parse events without CLI-specific assumptions
- headless JSON output is stable across runs for same outcome type

## W3: Code Structure and Testability

Tasks:
- Split `scripts/push.mjs` into modules:
  - `scripts/push/cli.mjs` (arg parsing + mode routing)
  - `scripts/push/engine.mjs` (assistant/tool loop)
  - `scripts/push/tools.mjs` (local tool executor + guards)
  - `scripts/push/session-store.mjs` (state/events persistence)
  - `scripts/push/provider.mjs` (SSE client + provider config)
- Add tests (Node `node:test` is sufficient for now):
  - tool-call parser
  - path escape guard
  - loop cutoff behavior
  - event serialization shape

Acceptance criteria:
- behavior unchanged from user perspective
- core loop/tool/session modules have deterministic unit coverage

## W4: `pushd` Skeleton

Tasks:
- Add a minimal daemon entrypoint:
  - `scripts/pushd.mjs`
- Implement minimal local IPC transport:
  - Unix socket (Linux/macOS)
  - request/response NDJSON
- Support minimal request types:
  - `hello`
  - `start_session`
  - `send_user_message`
  - `attach_session`
- Reuse the same engine module from W3 (no duplicate orchestration logic).

Acceptance criteria:
- one interactive `push` client can run through daemon path end-to-end
- protocol handshake works (`hello` + capabilities)

## Milestones

M1 (Hardening): W1 complete, CLI safe enough for daily use.  
M2 (Contract): W2 complete, event/output contract stable.  
M3 (Refactor): W3 complete, modular code + tests in place.  
M4 (Daemon Start): W4 complete, `pushd` skeleton operational.

## Suggested Execution Order

1. W1 Safety and Reliability Hardening
2. W3 Code Structure and Testability
3. W2 Protocol-Shape Alignment
4. W4 `pushd` Skeleton

Rationale:
- W1 reduces immediate risk.
- W3 makes W2/W4 faster and less brittle.
- W2 before W4 avoids rework in daemon event contracts.

## Immediate Next Tasks

1. Add `--json` to `push sessions`.
2. Add high-risk command detection + approval prompt in `exec`.
3. Extract session store + tool executor into separate modules.
4. Add first test file for path guard + parser.
