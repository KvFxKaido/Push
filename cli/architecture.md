# CLI Architecture

> Covers CLI-specific behavior only. For shared Push architecture and operating model, see [`../docs/architecture.md`](../docs/architecture.md).

## Overview

Push CLI is the local terminal agent for Push. It operates directly on the local workspace and currently supports three terminal surfaces:

- **Interactive REPL** — transcript-first conversational loop
- **Headless runs** — single-task execution with no interaction
- **Full-screen TUI** — terminal UI for session-driven coding work

The CLI shares the same role-based agent model and increasingly the same runtime semantics as the web app, while keeping terminal-specific coordination, rendering, and session handling local to `cli/`.

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

Primary entry points and helpers:

- `cli.ts` — `push run` command handling
- `task-brief.ts` — shared delegation brief formatting for headless tasks
- `tools.ts` — execution policy and mode-specific tool restrictions

### Full-screen TUI

The TUI is the full-screen terminal surface for session-based coding work. It keeps transcript readability central while adding pane layout, focused navigation, status visibility, and richer in-session affordances than the plain REPL.

Primary entry points and helpers:

- `tui.ts` — main TUI loop and screen orchestration
- `tui-renderer.ts` — rendering and layout helpers
- `tui-input.ts` / `tui-modal-input.ts` — inline and modal input behavior
- `tui-status.ts` — status line and compact state summaries
- `tui-theme.ts` — terminal theme and color helpers
- `tui-widgets.ts` — reusable terminal widgets
- `tui-completer.ts` / `tui-fuzzy.ts` — completion and fuzzy matching
- `tui-delegation-events.ts` — delegation event presentation inside the TUI

## Core Runtime Pieces

The CLI keeps several terminal-specific layers local even as more shared semantics move into root `lib/`.

- `cli.ts` — top-level command parsing and mode dispatch
- `engine.ts` — assistant turn loop, streaming, approval hooks, and execution flow
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
- **TUI** emphasizes persistent terminal layout, focus management, and richer session visibility

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

- [`../docs/architecture.md`](../docs/architecture.md) — shared architecture and operating model
- [`../docs/DESIGN.md`](../docs/DESIGN.md) — graphical app visual system

Use this file for CLI-specific runtime shape, terminal surfaces, and local architectural concerns.
