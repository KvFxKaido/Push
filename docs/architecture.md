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
- **Delegation** — Coder delegation and Explorer delegation from Orchestrator
- **Review sources** — Branch diff, Last commit, Working tree
- **Harness reliability** — hashline edits, resumable sessions, active branch handling
- **GitHub flow** — PR merge flow, branch-scoped chats, commit/push
- **Project instructions** — loading order: `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`

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

Local coding agent for the terminal. Same role-based agent architecture as the web app. Current direction is transcript-first CLI ergonomics and TUI-lite improvements; the existing TUI surface is experimental, not a ground-up rewrite target.

## Design System

Visual tokens, color palette, typography, spacing, components, and motion specs are in [`design-system.md`](design-system.md).
