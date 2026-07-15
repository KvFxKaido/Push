# CLI Architecture

> Covers CLI-specific behavior only. For shared Push architecture and operating model, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Overview

Push CLI is the local terminal agent for Push. It operates directly on the local workspace and currently supports three terminal surfaces:

- **Interactive REPL** — transcript-first conversational loop
- **Headless runs** — single-task execution with no interaction
- **Full-screen TUI** — terminal UI for session-driven coding work

The CLI shares the same role-based agent model and increasingly the same runtime semantics as the web app, while keeping terminal-specific coordination, rendering, and session handling local to `cli/`. Bare `./push` opens the full-screen TUI by default; the transcript REPL remains a first-class alternative (`PUSH_TUI_ENABLED=0`).

## Surfaces

### Interactive REPL

The REPL is the transcript-first CLI surface. It streams assistant responses, executes tools, supports in-session commands, and prompts for approval on high-risk actions.

Primary entry points and helpers:

- `cli.ts` — command routing and mode selection
- `engine.ts` — assistant loop and event emission
- `completer.ts` / `path-completion.ts` — transcript command and file completion

### Headless runs

Headless mode runs a single task and exits. It is optimized for automation, scripting, and acceptance-check workflows.

Notable traits:

- no interactive clarification loop
- high-risk exec flows are blocked unless explicitly enabled
- optional acceptance checks shape both runtime evaluation and process exit status
- saved JSONL receipts can be evaluated offline through the shared deterministic reducer

Primary entry points and helpers:

- `cli.ts` — `push run` command handling
- `runtime-eval-command.ts` — `push eval` receipt/policy loading, formatting, and exit semantics
- `tools.ts` — execution policy and mode-specific tool restrictions

### Full-screen TUI

The TUI is the default surface for bare `./push` in a TTY. It is built on [silvery](https://github.com/beorn/silvery) — React authoring over silvery's retained, damage-diffed cell compositor — adopted 2026-07-12 after an eleven-candidate survey (decision record: [`docs/decisions/Retained-Mode TUI — MVU + Pure-TS Compositor.md`](../docs/decisions/Retained-Mode%20TUI%20—%20MVU%20+%20Pure-TS%20Compositor.md)). The previous hand-rolled ANSI renderer (`tui.ts` and its screen buffer) is deleted; silvery is view-only — the shared `lib/` runtime contracts are untouched. Requires Node ≥24 (`launchTui()` fails fast with a clear message below it).

Primary entry points and helpers:

- `cli.ts` `launchTui()` — renderer dispatch: Node-version guard, then loads the silvery entry
- `silvery/entry.tsx` — silvery render entry; wires options into the shell
- `silvery/push-shell.tsx` — root shell: `SilveryErrorBoundary` + `RecoverableBoundary` + process watchdog (the three-layer silent-fault workaround) and the pinned `TERMINAL_RESTORE_SEQUENCE` emergency reset
- `silvery/surface.tsx` — the Push surface: transcript, composer, status, modals
- `silvery/controller.ts` — bridges config/session/daemon verbs into the React surface
- `tui-daemon-session.ts` — `DaemonSessionController`: the daemon-session state, connect/reconnect lifecycle, and typed session verbs behind a hook seam
- `tui-handoff.ts` — terminal handoff/reclaim: suspend the TUI for `$EDITOR`, pagers, and interactive children behind the `TuiIo` seam
- `tui-input.ts` / `tui-modal-input.ts` — key parsing and modal input behavior
- `tui-renderer.ts` — ANSI escape and text-measurement utilities (CJK-aware width, wrapping)
- `tui-status.ts` — status line and compact state summaries
- `tui-theme.ts` — terminal theme and color helpers
- `tui-completer.ts` / `tui-fuzzy.ts` — completion and fuzzy matching
- `tui-delegation-events.ts` — delegation event presentation inside the TUI

## Core Runtime Pieces

The CLI keeps several terminal-specific layers local even as more shared semantics move into root `lib/`.

- `cli.ts` — top-level command parsing and mode dispatch
- `engine.ts` — assistant turn loop, streaming, approval hooks, and execution flow
- `lead-turn.ts` — the lead-kernel lane: every interactive turn as a `leadMode` run of the shared coder kernel
- `lead-explorer.ts` — the lead's Explorer fan-out (read-only investigation delegation) and the shared read-only tool executor the daemon's delegated runs wrap
- `tools.ts` — tool routing, guardrails, structured results, and policy differences by mode
- `provider.ts` — provider integration and streaming normalization
- `protocol-schema.ts` — event, payload, and protocol shape used by the CLI runtime
- `context-manager.ts` — context shaping and message compaction helpers
- `workspace-context.ts` — git/workspace state discovery and summary formatting
- `session-store.ts` — local session persistence under `~/.push/sessions`
- `pushd.ts`, `daemon-client.ts`, `daemon-provider-stream.ts`, `client-attach-state.ts` — background daemon, attach/resume, and event replay support
- `diagnostics.ts` — workspace diagnostics and verification support
- `hashline.ts`, `file-ledger.ts`, `file-references.ts` — file edit safety and reference tracking

## Mode Relationships

All three CLI surfaces share the same core assistant runtime, tool semantics, provider model, and session concepts where possible.

They differ mainly in interaction model:

- **REPL** emphasizes linear transcript interaction
- **Headless** emphasizes one-shot completion and machine-readable outcomes
- **TUI** emphasizes persistent terminal layout, focus management, and richer session visibility when the full-screen shell is explicitly chosen

The design target is a shared runtime contract across surfaces, not identical interaction or rendering.

## Terminal-Specific Constraints

CLI architecture is shaped by constraints that do not apply to the graphical app:

- **Keyboard-first interaction** — no hover-dependent behavior
- **Terminal size variability** — layouts must degrade cleanly in narrow or short viewports
- **ANSI/color capability limits** — presentation cannot depend on full graphical styling support
- **Direct filesystem operation** — local workspace state and shell execution are first-class concerns
- **Attach/resume flows** — sessions may outlive an individual terminal client connection
- **Streaming-first output** — transcript clarity and incremental state updates matter more than decorative layout

## Relationship to Shared Push Docs

The CLI inherits shared product-wide rules from the root docs, including branch/session expectations where applicable, provider routing concepts, and delivery semantics.

Use the root docs for shared truths:

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — shared architecture and operating model
- [`../DESIGN.md`](../DESIGN.md) — graphical app visual system

Use this file for CLI-specific runtime shape, terminal surfaces, and local architectural concerns.
