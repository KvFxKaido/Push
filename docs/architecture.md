# Architecture


## Design Philosophy

Push is built around execution-first reliability. We favor explicit state and human-in-the-loop validation over black-box automation. Key constraints:

- **Repo-anchored context** — behavior is always bound to a specific branch and repository state.
- **Role-based delegation** — distinct agents (Explorer, Coder, Auditor) provide separation of concerns and layered verification.
- **Surgical edits** — preference for hashline-anchored changes and patchset transactions over broad file overwrites.
- **Audited delivery** — the Auditor role serves as a mandatory safety gate for all standard commits.

## Tech Stack

- React 19 + TypeScript 6 (emit) / 7 native-preview (typecheck via `tsgo`) + Vite 7
- Tailwind CSS 3 + shadcn/ui (Radix primitives)
- GitHub REST API for repo operations
- Multi-backend AI with built-ins plus opt-in private connectors
- Pluggable sandbox backend — Cloudflare Sandbox SDK (default) or Modal, selected server-side via the `PUSH_SANDBOX_PROVIDER` var
- Cloudflare Workers for streaming proxy and sandbox proxy (both backends route through the same Worker)
- PWA with service worker and offline support
- Experimental Android app via Capacitor, wrapping the production web bundle for native WebView testing and debug APKs

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
- **Sandbox execution** — scratch workspaces and web search tools via a pluggable `SandboxProvider` interface (`lib/sandbox-provider.ts`); Cloudflare Sandbox SDK and Modal coexist as sibling providers, both reached through the same `/api/sandbox/*` Worker route with server-side dispatch on `PUSH_SANDBOX_PROVIDER`
- **Daemon-backed sessions** — experimental Local PC and Remote modes pair the web app to `pushd` over loopback or the Worker relay; chat `sandbox_*` calls route through the hook-owned daemon WebSocket for `sandbox_exec`, file read/write/list, and diff
- **Delegation and orchestration** — direct Explorer/Coder delegation plus dependency-aware task graphs via `plan_tasks`
- **Context and memory** — staged compaction, Coder working memory, graph-scoped task memory, typed retrieval/invalidation, and sectioned prompt packing
- **Shared runtime contract** — canonical task-graph, memory, delegation-brief, role-context, and run-event semantics live in root `lib/` and are consumed by both web and CLI
- **Sandbox awareness** — session capability blocks expose container lifetime, creation/download events, and recent workspace lifecycle state directly to the agent
- **Workspace Hub** — scratchpad, console, files, diff, PRs, review, and commit/push live in a single branch-scoped coding surface
- **Renderable artifacts** — `create_artifact` accepts four kinds (`static-html`, `static-react`, `mermaid`, `file-tree`) and persists typed records under `repoFullName + branch + chatId` (web) or `repoFullName + branch` (CLI). `live-preview` is a fifth record kind in the type system but is intentionally not creatable through `create_artifact` because it needs sandbox-side dev-server orchestration; a separate `create_live_preview` tool is reserved for it (not yet implemented). Web stores in Workers KV via the `/api/artifacts/*` routes; CLI stores as flat JSON under `~/.push/artifacts/`. Renderers under `app/src/components/artifacts/` are kind-dispatched and lazy-loaded so chats only pay for what they show
- **Review sources** — Branch diff, Last commit, Working tree
- **Harness reliability** — adaptive hashline edits, patchset transactions, resumable sessions, and active branch handling
- **GitHub flow** — PR merge flow, branch-scoped chats, commit/push, and workspace publish-to-GitHub
- **Project instructions** — web/repo loading order: `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`; CLI also supports `.push/instructions.md` as a higher-priority local override

## Repo / Session Model

- Exactly one active branch exists per repo session.
- The active branch is the commit target, push target, diff base, and chat context.
- Chats are branch-scoped. They stay bound to the branch they were started on, except in a *fork*: when the user (or a model tool call) creates a new branch from the current workspace state, the active conversation migrates to the new branch alongside the still-running sandbox.
- Branch transitions are explicit but preserve context. The sandbox is *not* torn down — it stays alive across the switch. The chat hook receives a normalized `BranchSwitchPayload { kind: 'forked' | 'switched', name, previous?, ... }`: `'forked'` migrates the active conversation onto the new branch, `'switched'` routes to the existing chat for the target branch (or auto-creates one).
- Branch creation and switching are tool-callable, not UI-only. Foreground tools `create_branch` (creates a new branch from current state, emits `kind: 'forked'`) and `switch_branch` (switches to an existing branch, emits `kind: 'switched'`) keep Push's tracked branch in sync with sandbox HEAD. Long-form aliases `sandbox_create_branch` and `sandbox_switch_branch` still resolve. Raw `git checkout <branch>` / `git switch <branch>` (and `-b` / `-c` variants) are blocked in `sandbox_exec` regardless of approval mode and routed through the typed tools — the issue is state synchronization, not consent. The detection is best-effort: bare names are caught; for `git checkout`, `/` or `.` in the operand defers to the user so file restores like `src/utils` still work; for `git switch`, slash-shaped branch names like `feat/foo` are blocked because `switch` is branch-only. Models that know they're switching branches should use the typed tools directly.
- Foreground/background result boundary: foreground tools emit `branchSwitch` for UI routing (chat migration / selection); background coder jobs emit `meta: { branchCreated?, branchSwitched? }` for observability only. No background result fires chat or routing side effects. `create_branch` is wired for both surfaces; `switch_branch` is foreground-only.

## Delivery and Review Rules

- Standard commits go through the Auditor as a required SAFE/UNSAFE gate.
- Reviewer is advisory and can review the branch diff, last commit, or working tree.
- Only PR-backed branch diff reviews can be posted back to GitHub as PR reviews.
- Standard merges happen through the GitHub pull request flow only.
- Push never runs local `git merge`.
- Repository protections such as Protect Main may block direct commits to `main`.

## Workspace Modes

- **Repo-backed mode** — repo-locked context, branch-scoped chats, GitHub-backed review/commit/push flows
- **Scratch workspace mode** — sandbox-only workspace for quick experiments without repo auth
- **Local PC / Remote modes** — flag-gated daemon-backed chat surfaces (`VITE_LOCAL_PC_MODE`, `VITE_RELAY_MODE`) that drive a paired `pushd`; they intentionally omit cloud-sandbox and GitHub repo affordances
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
| `app/` | Web app, experimental Capacitor Android shell, Cloudflare Worker, UI, hooks, and app logic |
| `app/android/` | Generated Capacitor Android project; gitignored and regenerated by `npm run android:setup` |
| `cli/` | Local terminal agent, sessions, daemon, and terminal interface |
| `sandbox/` | Modal sandbox backend (Python + FastAPI endpoints) |
| `Dockerfile.sandbox` | Cloudflare Sandbox container image (extends `cloudflare/sandbox:0.8.11-python`) |
| `lib/` | Shared logic used across app and CLI |
| `docs/` | Architecture, decisions, runbooks, and archived references |
| `scripts/` | Build and utility scripts |
| `mcp/` | MCP server integration |
| `tests/` | Test suites |

## CLI

Local coding agent for the terminal. It shares the same role-based architecture and increasingly the same runtime semantics as the web app, while keeping terminal-specific coordination local. Current terminal work is focused on transcript-first CLI ergonomics and TUI-lite improvements; the `push` wrapper still enables the full-screen TUI by default today, while `PUSH_TUI_ENABLED=0 ./push` runs the transcript REPL. The target is a stronger shared runtime contract across web and CLI, not identical UX across surfaces.

## Android

The Android app is an experimental Capacitor shell around the web app. It uses the same built Vite assets and Worker-backed API surface as the browser app, with native WebView behavior handled by Capacitor. The generated `app/android/` project is not source-controlled; `npm run android:setup` recreates it on clean checkouts, and `npm run android:sync` builds the SPA, bootstraps Android, and syncs assets into the native project.

Current Android scope is debug builds, emulator/device smoke testing, OAuth/WebView validation, and CI build verification. Release signing, Play distribution, native feature expansion, and instrumented device tests are intentionally out of scope until the mobile surface graduates from experimental.

## Design System

Visual tokens, color palette, typography, spacing, components, and motion specs are in [`DESIGN.md`](DESIGN.md).
