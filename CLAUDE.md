# Push — Mobile AI Coding Agent

CLAUDE.md is the canonical detailed source for Push. Keep architecture, workflow, and operational details here; the root README.md, AGENTS.md, and GEMINI.md should stay as short compatibility/overview shims that point back to this file.

## Quick Start

```bash
cd app
npm install
npm run dev
```

## Tech Stack

- React 19 + TypeScript 6 + Vite 7
- Tailwind CSS 3 + shadcn/ui (Radix primitives)
- GitHub REST API for repo operations
- Multi-backend AI with built-ins plus opt-in private connectors
- Modal for sandbox code execution
- Cloudflare Workers for streaming proxy and sandbox proxy
- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. Backend/model routing is currently hybrid: Settings stores defaults and the active backend preference, chat/review selection happens separately, and the role split stays fixed underneath.

- **Orchestrator** — Conversational lead, interprets intent, and delegates to Explorer or Coder as needed.
- **Explorer** — Autonomous read-only investigation for code tracing, architecture discovery, and evidence gathering.
- **Coder** — Autonomous code implementation and execution in the sandbox.
- **Reviewer** — On-demand advisory diff review in the Workspace Hub.
- **Auditor** — Pre-commit safety gate with a binary SAFE/UNSAFE verdict.

## Key Systems

- Tool protocol, multi-tool dispatch, and structured error reporting
- Sandbox execution, scratch workspaces, and web search tools
- Coder delegation and Explorer delegation
- Reviewer sources: Branch diff, Last commit, Working tree
- Harness reliability, hashline edits, resumable sessions, and active branch handling
- GitHub PR merge flow and branch-scoped chats
- Project instruction loading order: `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`

## Push CLI

Local coding agent for the terminal. Same role-based agent architecture as the web app.

## Notes

Keep this file as the single detailed source of truth. If another root doc needs a new operational detail, add it here and leave the others as shims.
