# Architecture

## Tech Stack

- React 19 + TypeScript 6 + Vite 7
- Tailwind CSS 3 + shadcn/ui (Radix primitives)
- GitHub REST API for repo operations
- Multi-backend AI with built-ins plus opt-in private connectors
- Modal for sandbox code execution
- Cloudflare Workers for streaming proxy and sandbox proxy
- PWA with service worker and offline support

## Agent Roles

Role-based agent system. Models are replaceable. Roles are locked. Backend/model routing is hybrid: Settings stores defaults and the active backend preference, chat/review selection happens separately, and the role split stays fixed underneath.

| Role | Responsibility |
|---|---|
| **Orchestrator** | Conversational lead, interprets intent, delegates to Explorer or Coder |
| **Explorer** | Autonomous read-only investigation — code tracing, architecture discovery, evidence gathering |
| **Coder** | Autonomous code implementation and execution in the sandbox |
| **Reviewer** | On-demand advisory diff review in the Workspace Hub |
| **Auditor** | Pre-commit safety gate with a binary SAFE/UNSAFE verdict |

### Provider Routing

- Settings stores default backend/model picks plus the active backend preference.
- The current chat locks the Orchestrator provider/model on first send.
- Delegated Coder and Explorer runs inherit the chat-locked provider/model.
- Reviewer keeps its own sticky provider/model selection.
- Auditor follows the chat lock when available, otherwise the active backend.

## Key Systems

- **Tool protocol** — multi-tool dispatch and structured error reporting
- **Sandbox execution** — scratch workspaces and web search tools via Modal
- **Delegation and orchestration** — direct Explorer/Coder delegation plus dependency-aware task graphs via `plan_tasks`
- **Context and memory** — staged compaction, Coder working memory, graph-scoped task memory, typed retrieval/invalidation, and sectioned prompt packing
- **Shared runtime contract** — canonical task-graph, memory, delegation-brief, role-context, and run-event semantics live in root `lib/` and are consumed by both web and CLI
- **Sandbox awareness** — session capability blocks expose container lifetime, creation/download events, and recent workspace lifecycle state directly to the agent
- **Review sources** — Branch diff, Last commit, Working tree
- **Harness reliability** — adaptive hashline edits, patchset transactions, resumable sessions, and active branch handling
- **GitHub flow** — PR merge flow, branch-scoped chats, commit/push, and workspace publish-to-GitHub
- **Project instructions** — loading order: `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`

## Workspace Modes

- **Repo-backed mode** — repo-locked context, branch-scoped chats, GitHub-backed review/commit/push flows
- **Scratch workspace mode** — sandbox-only workspace for quick experiments without repo auth
- **Workspace publish flow** — scratch work can be promoted into a user-owned GitHub repo from inside the app, with explicit `Private`/`Public` visibility

## Shared Runtime Shape

Root `lib/` is now the canonical home for cross-surface runtime semantics, including:

- task-graph execution
- typed context-memory storage/retrieval/invalidation/packing
- delegation brief formatting and role-context helpers
- run phases and event vocabulary

The web app and CLI still keep shell-specific coordinators local. The target is the same agent/runtime contract across surfaces, not identical UI or transport.

## Repo Map

| Directory | Purpose |
|---|---|
| `app/` | Web app, Cloudflare Worker, UI, hooks, and app logic |
| `cli/` | Local terminal agent, sessions, daemon, and terminal interface |
| `sandbox/` | Modal sandbox backend |
| `lib/` | Shared logic used across app and CLI |
| `docs/` | Architecture, decisions, runbooks, and archived references |
| `scripts/` | Build and utility scripts |
| `mcp/` | MCP server integration |
| `tests/` | Test suites |

## CLI

Local coding agent for the terminal. It shares the same role-based architecture and increasingly the same runtime semantics as the web app, while keeping terminal-specific coordination local. Current direction is transcript-first CLI ergonomics, selective adoption of the shared runtime substrate, and TUI-lite improvements; the existing TUI surface is experimental, not a ground-up rewrite target.

## Design System

Visual tokens, color palette, typography, spacing, components, and motion specs are in [`DESIGN.md`](DESIGN.md).
