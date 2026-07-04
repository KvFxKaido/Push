# Architecture


## Design Philosophy

Push is built around execution-first reliability. We favor explicit state and human-in-the-loop validation over black-box automation. Key constraints:

- **Repo-anchored context** — behavior is always bound to a specific branch and repository state.
- **Runtime delegation, phase-first presentation** — internal roles provide separation of concerns and layered verification, while user-facing surfaces render workflow phases through a display vocabulary seam.
- **Surgical edits** — preference for hashline-anchored changes and patchset transactions over broad file overwrites.
- **Audited delivery** — the Auditor role serves as a default-on delivery gate: web/cloud audits the cumulative push diff, while CLI commits still use a pre-commit gate.

## Tech Stack

- React 19 + Vite 8 (Rolldown). TypeScript is mid-transition to 7.0: `cli/` and `mcp/github-server` run TS 7.0 RC (typecheck **and** emit via the native `tsc`); the `app/` stays on TS 7 native-preview typecheck (`tsgo`) + TS 6 for emit/ESLint until typescript-eslint supports the TS 7 programmatic API (lands in 7.1)
- Tailwind CSS 4 + shadcn/ui (Radix primitives)
- GitHub REST API for repo operations
- Multi-backend AI with built-ins plus opt-in private connectors
- Pluggable sandbox backend — Cloudflare Sandbox SDK (default) or Modal, selected server-side via the `PUSH_SANDBOX_PROVIDER` var
- Cloudflare Workers for streaming proxy and sandbox proxy (both backends route through the same Worker)
- PWA with service worker and offline support
- Experimental Android app via Capacitor, wrapping the production web bundle for native WebView testing and debug APKs

## Agent Roles and Display Vocabulary

Role-based runtime system. Models are replaceable. Internal roles are locked. Backend/model routing is hybrid: Settings stores defaults and the active backend preference, chat/review selection happens separately, and the role split stays fixed underneath.

Since the **Coder Delegation Collapse** (PR #783), the Orchestrator is the **single capable lead**: it reads, edits, runs commands/tests, and ships directly in one loop rather than handing ordinary coding to a separate Coder. The Coder role still exists and is granted (`delegate:coder` is retained), but it is now the **detached path** — CLI/daemon task graphs and background jobs — not the default foreground flow. Explorer remains read-only investigation, pulled in only when isolating it adds leverage.

The runtime role contract is not the user-facing vocabulary. Human-readable labels flow through `lib/role-display.ts`: Explorer/Coder read as workflow phases ("Exploring", "Editing"), Orchestrator source attribution reads as "Assistant", and Reviewer/Auditor keep names where independent attribution improves trust. Raw role strings still belong in capability checks, event payloads, logs, persisted data, and role-kernel module names.

| Role | Responsibility |
|---|---|
| **Orchestrator** | Single capable lead — interprets intent and does the work directly (read → edit → run → ship); delegates read-only investigation to Explorer, and code work to the Coder only on the detached/CLI task-graph path |
| **Explorer** | Autonomous read-only investigation — code tracing, architecture discovery, evidence gathering |
| **Coder** | Autonomous code implementation and execution in the sandbox — the detached path (CLI/daemon task graphs, background jobs), no longer the default foreground flow |
| **Reviewer** | On-demand advisory diff review in the Workspace Hub |
| **Auditor** | Delivery safety gate with a binary SAFE/UNSAFE verdict: push-boundary on web/cloud, pre-commit on CLI |

### Provider Routing

- Settings stores default backend/model picks plus the active backend preference.
- The current chat locks the Orchestrator provider/model on first send.
- Delegated Coder and Explorer runs inherit the chat-locked provider/model.
- Reviewer keeps its own sticky provider/model selection.
- Auditor follows the chat lock when available, otherwise the active backend.

## Key Systems

- **Tool protocol** — multi-tool dispatch and structured error reporting
- **Sandbox execution** — scratch workspaces and web search tools via a pluggable `SandboxProvider` interface (`lib/sandbox-provider.ts`); Cloudflare Sandbox SDK and Modal coexist as sibling providers. The shared `/api/sandbox/*` Worker route can dispatch by `PUSH_SANDBOX_PROVIDER`, while `CloudflareSandboxProvider` deliberately pins direct provider traffic to `/api/sandbox-cf/*`.
- **Daemon-backed sessions** — the experimental Remote mode pairs the web app to `pushd` over the Worker relay; chat `sandbox_*` calls route through the hook-owned daemon WebSocket for `sandbox_exec`, file read/write/list, and diff
- **Delegation and orchestration** — direct Explorer/Coder runtime delegation plus dependency-aware task graphs via `plan_tasks`
- **Context and memory** — staged compaction, Coder working memory, graph-scoped task memory, typed retrieval/invalidation, and sectioned prompt packing
- **Shared runtime contract** — canonical task-graph, memory, delegation-brief, role-context, role-display, and run-event semantics live in root `lib/` and are consumed by both web and CLI
- **Sandbox awareness** — session capability blocks expose container lifetime, creation/download events, and recent workspace lifecycle state directly to the agent
- **Workspace Hub** — scratchpad, console, files, diff, PRs, review, and commit/push live in a single repo-scoped coding surface
- **Renderable artifacts** — `create_artifact` accepts four kinds (`static-html`, `static-react`, `mermaid`, `file-tree`) and persists typed records under `repoFullName + branch + chatId` (web) or `repoFullName + branch` (CLI). `live-preview` is a fifth record kind in the type system but is intentionally not creatable through `create_artifact` because it needs sandbox-side dev-server orchestration; a separate `create_live_preview` tool is reserved for it (not yet implemented). Web stores in Workers KV via the `/api/artifacts/*` routes; CLI stores as flat JSON under `~/.push/artifacts/`. Renderers under `app/src/components/artifacts/` are kind-dispatched and lazy-loaded so chats only pay for what they show
- **Review sources** — Branch diff, Last commit, Working tree
- **Harness reliability** — adaptive hashline edits, patchset transactions, resumable sessions, and active branch handling
- **GitHub flow** — PR merge flow, repo-scoped chats, commit/push, and workspace publish-to-GitHub
- **Project instructions** — loading order on both surfaces: `PUSH.md` (Push-specific override) → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`
- **User goal** — Web derives a `UserGoalAnchor` from the first user turn (plus recent redirects) and, after compaction, injects it as a `[USER_GOAL]` block near the recent tail. Web `plan_tasks` validates per-node `addresses` only when that anchor exists, then carries `userGoal` and `addresses` into delegated Coder/Explorer briefs. CLI has `<cwd>/.push/goal.md` parsing/seeding helpers and task-brief rendering for `userGoal`/`addresses`, but the active daemon task-graph path currently treats those fields as optional and does not load or enforce the file. Distinct from the **scratchpad** (free-form notes, agent-writable, `[SCRATCHPAD]` block): user-goal anchors are structured user intent, while scratchpad is prose memory. If content has a `## Initial ask` shape, it belongs in `goal.md`, not scratchpad.

## Repo / Session Model

- Exactly one active branch exists per repo session.
- The active branch is the commit target, push target, and diff base — **mutable session state** that follows sandbox HEAD, not a fixed property of the chat.
- Chats are **repo-scoped**, not branch-scoped: a chat lists under its repo regardless of branch and **carries across branch switches**. The branch is `conv.branch` (mutable session state), so there is no per-branch chat to migrate to.
- Branch transitions **update the active conversation's `conv.branch` in place**. The typed branch tools (and the chat-resume path) preserve the sandbox via `skipBranchTeardownRef` (warm switch) and the chat hook receives a normalized `BranchSwitchPayload { kind: 'forked' | 'switched' | 'merged', name, previous?, ... }` that updates `conv.branch` in place — `'forked'` / `'merged'` also append a passive `branch_forked` / `branch_merged` timeline moment, and per-message `message.branch` stamps record write-time provenance. A bare UI swap that bypasses the warm path restarts the sandbox (the desync guard); resuming a chat warm-restores its saved branch. (The `'carried'` kind and the old chat-migration machinery were removed in #1257 / #1258 — see [`docs/decisions/Repo-Scoped Chats — Branch as Session State.md`](<docs/decisions/Repo-Scoped Chats — Branch as Session State.md>).)
- Branch creation and switching are tool-callable, not UI-only. Foreground tools `create_branch` (creates a new branch from current state, emits `kind: 'forked'`) and `switch_branch` (switches to an existing branch, emits `kind: 'switched'`) keep Push's tracked branch in sync with sandbox HEAD. Long-form aliases `sandbox_create_branch` and `sandbox_switch_branch` still resolve. Raw `git checkout <branch>` / `git switch <branch>` (and `-b` / `-c` variants) are blocked in `sandbox_exec` regardless of approval mode and routed through the typed tools — the issue is state synchronization, not consent. Both subcommands route ordinary single bare positional operands through the typed switch path: for `git checkout` the syntax does not disambiguate branch from path, so `git checkout feat/foo` and `git checkout src/utils.ts` both route; for `git switch` (branch-only), the route forces branch ops through the typed tools. File restores require the explicit form: `git checkout -- <path>` or two-positional `git checkout HEAD <path>`. Ref expressions (`HEAD`, `HEAD~1`, `main^`, `branch@{upstream}`) pass through. The previous-branch shorthand (`git checkout -` / `git switch -`) is still allowed today; `lib/git/policy.ts` pins that as a known deferred behavior change rather than current branch-tool routing. `git branch -m` / `-M` / `--move` is blocked outright (`branch-rename`, no `allowDirectGit` escape) — renaming the checked-out branch would desync Push's tracked branch from sandbox HEAD, and there is no typed rename tool; the supported recipe is `create_branch` at the same commit, then delete the old name (list / create / delete / upstream `git branch` forms are unaffected). Models that know they're switching branches should use the typed tools directly.
- Foreground/background result boundary: foreground tools emit `branchSwitch` for the in-place `conv.branch` update (no chat migration / selection); background coder jobs emit `meta: { branchCreated?, branchSwitched? }` for observability only. No background result fires chat or routing side effects. `create_branch` is wired for both surfaces; `switch_branch` is foreground-only.

## Delivery and Review Rules

- Web/cloud delivery uses **Gate-at-Push**: `sandbox_commit` makes a silent local commit (pre-commit hook + auto-branch off main, no Auditor card), then `prepare_push` audits the cumulative push diff and returns the review card; direct `sandbox_push` also runs the push-time Auditor gate. CLI/daemon `git_commit` still routes through the `PreCommitGate` seam before the commit lands. Both surfaces default on and fail closed when the Auditor backend is required but unavailable.
- Reviewer is advisory and can review the branch diff, last commit, or working tree.
- Only PR-backed branch diff reviews can be posted back to GitHub as PR reviews.
- Standard merges happen through the GitHub pull request flow only.
- Push never runs local `git merge`.
- Repository protections such as Protect Main may block direct commits to `main`.

## Workspace Modes

- **Repo-backed mode** — repo-locked context, repo-scoped chats, GitHub-backed review/commit/push flows
- **Scratch workspace mode** — sandbox-only workspace for quick experiments without repo auth
- **Remote mode** — a flag-gated daemon-backed chat surface (`VITE_RELAY_MODE`) that drives a paired `pushd` over the Worker relay. Its web hub surface is intentionally trimmed compared with cloud repo mode; the local-daemon runtime drops remote write capabilities by default, then restores token-backed GitHub PR/workflow capabilities when a real GitHub remote is available.
- **Workspace publish flow** — scratch work can be promoted into a user-owned GitHub repo from inside the app, with explicit `Private`/`Public` visibility

## Shared Runtime Shape

Root `lib/` is now the canonical home for cross-surface runtime semantics, including:

- task-graph execution
- typed context-memory storage/retrieval/invalidation/packing
- delegation brief formatting and role-context helpers
- run phases, display vocabulary, and event vocabulary

The web app and CLI still keep shell-specific coordinators local. The target is the same agent/runtime contract across surfaces, not identical UI or transport.

## Repo Map

| Directory | Purpose |
|---|---|
| `app/` | Web app, experimental Capacitor Android shell, Cloudflare Worker, UI, hooks, and app logic |
| `app/android/` | Capacitor Android project; committed source with native customization. Build outputs and regenerated web assets are ignored. |
| `cli/` | Local terminal agent, sessions, daemon, and terminal interface |
| `sandbox/` | Modal sandbox backend (Python + FastAPI endpoints) |
| `Dockerfile.sandbox` | Cloudflare Sandbox container image (extends `cloudflare/sandbox:0.12.1-python`) |
| `lib/` | Shared logic used across app and CLI |
| `docs/` | Architecture, decisions, runbooks, and archived references |
| `scripts/` | Build and utility scripts |
| `mcp/` | MCP server integration |
| `tests/` | Test suites |

## CLI

Local coding agent for the terminal. It shares the same internal runtime contracts as the web app, while keeping terminal-specific coordination and presentation local. Current terminal work is focused on transcript-first CLI ergonomics and TUI-lite improvements; bare `./push` (or `node cli/cli.ts`) opens the full-screen TUI by default — set `PUSH_TUI_ENABLED=0` to opt back to the transcript REPL. The target is a stronger shared runtime contract across web and CLI, not identical UX across surfaces.

## Android

The Android app is an experimental Capacitor shell around the web app. It uses the same built Vite assets and Worker-backed API surface as the browser app, with native WebView behavior handled by Capacitor. `app/android/` is committed source because it carries native customization (for example the native Git plugin wiring, desugaring, and proguard fixes). `npm run android:sync` builds the SPA, ensures the Android project exists, and syncs regenerated web assets and plugin registration.

Current Android scope is debug builds, emulator/device smoke testing, OAuth/WebView validation, and CI build verification. Release signing, Play distribution, native feature expansion, and instrumented device tests are intentionally out of scope until the mobile surface graduates from experimental.

## Design System

Visual tokens, color palette, typography, spacing, components, and motion specs are in [`DESIGN.md`](DESIGN.md).
