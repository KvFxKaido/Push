# Push — AI Agent Context

AI coding agent — mobile PWA + local CLI. Chat with your codebase — review PRs, explore changes, and ship code from your phone or terminal.

## Project Overview

Push is a personal chat interface backed by role-based AI agents. Users select a repo, ask questions, and the agent reads code, analyzes PRs, runs code in a sandbox, and shows results as inline cards — all in a streaming conversation.

**Core Philosophy:**
- Chat-first — conversation is the primary interface
- Repo-locked context — agent only sees the selected repo
- Live pipeline — every agent step visible in real time
- Show, don't dump — rich inline cards instead of walls of text
- Harness-first reliability — prioritize tool-loop and execution quality over model churn

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript 5.9, Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Multi-backend: Ollama, Mistral, OpenRouter, Z.AI, Google, OpenCode Zen (user picks, all roles) |
| Backend | Cloudflare Workers (TypeScript) |
| Sandbox | Modal (serverless Python containers) |
| APIs | GitHub REST API |

## Architecture

### Role-Based Agent System

The active backend serves all three roles. The user picks a backend in Settings; all agents use it.

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Conversational lead, interprets intent, delegates to Coder |
| **Coder** | Autonomous code implementation in sandbox (unbounded rounds, 90s timeout per round) |
| **Auditor** | Pre-commit risk review — binary SAFE/UNSAFE verdict (fail-safe) |

### AI Backends

Six providers, all using OpenAI-compatible SSE streaming. Any single API key is sufficient. Provider selection is locked per chat after the first user message. Web default backend mode is **Auto** (Zen-first when available), with explicit per-provider override in Settings. Production uses Cloudflare Worker proxies at `/api/ollama/chat`, `/api/mistral/chat`, `/api/openrouter/chat`, `/api/zai/chat`, `/api/google/chat`, and `/api/zen/chat`.

| Provider | Default Model |
|----------|---------------|
| **Ollama Cloud** | gemini-3-flash-preview |
| **Mistral Vibe** | devstral-small-latest |
| **OpenRouter** | claude-sonnet-4.6 |
| **Z.AI** | glm-4.5 |
| **Google Gemini** | gemini-2.5-flash |
| **OpenCode Zen** | qwen3-coder |

**OpenRouter** provides access to 50+ models through a single API. Push includes 12 curated models: Claude Sonnet 4.6, Opus 4.6, and Haiku 4.5, GPT-5.2/5-mini/o1, 2 Codex variants (5.2/5.1), Gemini 3.1 Pro Preview/3 Flash, Grok 4.1, and Kimi K2.5.

### Tool Protocol

Tools are prompt-engineered — the system prompt defines available tools and JSON format. The agent emits JSON tool blocks, the client executes them, injects results as synthetic messages, and re-calls the LLM. Both the Orchestrator and Coder tool loops are unbounded. The Coder has a 90s per-round timeout and 60KB context cap as safety nets.

Multi-tool dispatch: `detectAllToolCalls()` scans for all tool calls per message, splits them into parallel read-only calls and an optional trailing mutation — reads execute via `Promise.all()`, then the mutation runs. Tool results include structured error fields (`error_type`, `retryable`) via `classifyError()`, a `[meta]` envelope with round number, context size, and sandbox dirty state, and malformed-call feedback includes a `[TOOL_CALL_PARSE_ERROR]` header with structured diagnosis.

The Orchestrator can delegate complex coding tasks to the Coder sub-agent via `delegate_coder`. The Coder runs autonomously with its own tool loop in the sandbox, then returns results to the Orchestrator. Delegation supports optional `acceptanceCriteria[]` — shell commands run post-task to verify success. The Coder maintains internal working memory (`CoderWorkingMemory`) via `coder_update_state`, injected as a `[CODER_STATE]` block into every tool result to survive context trimming.

### Harness Focus

Current harness priorities are tracked in `documents/plans/Harness Reliability Plan.md`:
- edit reliability — **`sandbox_edit_file` + hashline protocol are shipped and active**; edits reference 7-char content hashes (`HashlineOp[]`) via `lib/hashline.ts`, eliminating line-number drift; `lib/file-awareness-ledger.ts` tracks per-file read coverage for edit safety
- read/context efficiency — Track B shipped: `sandbox_read_file` line ranges, numbered range output, out-of-bounds empty-range warning
- tool-loop robustness — `lib/tool-call-metrics.ts` captures malformed tool-call reasons by provider
- server-side background execution design is deferred; resumable sessions are the active interruption-recovery path
- operator visibility and failure diagnostics — `lib/edit-metrics.ts` tracks write latency/stale/error counts
- **Agent Experience Wishlist shipped** (see `documents/analysis/Agent Experience Wishlist.md`): error taxonomy with retry semantics (`classifyError()`), structured malformed-call feedback (`[TOOL_CALL_PARSE_ERROR]`), edit result diffs, multi-tool per turn (`detectAllToolCalls()`), universal meta envelope (`[meta]` line on every tool result), machine-checkable acceptance criteria, agent working memory (`CoderWorkingMemory`), `sandbox_read_symbols` (AST/regex symbol extraction), `sandbox_apply_patchset` (multi-file transactional edits)

### Browser Tools (Optional)

- `sandbox_browser_screenshot` — capture a webpage screenshot and render a preview card
- `sandbox_browser_extract` — extract main text from a URL, with optional `selector:` / `css:` instruction prefixes

Prompt-gated by `VITE_BROWSER_TOOL_ENABLED=true`. Routed through Worker endpoints.

### Web Search Tools

The Orchestrator can search the web mid-conversation via `web-search-tools.ts`. Three backends: **Tavily** (premium, LLM-optimized results via `VITE_TAVILY_API_KEY`), **Ollama native search** (POST `/api/web_search`), and **DuckDuckGo** (free fallback). For native function-calling providers (Mistral/OpenRouter/Z.AI/Google/Zen), web search is exposed via request `tools[]` (`web_search`), not the Mistral Agents API path.

### User Identity

Users set a display name, bio, and GitHub login in Settings. Stored in localStorage via `useUserProfile` hook. Injected into both Orchestrator and Coder system prompts via `buildUserIdentityBlock()`. Bio is escaped to prevent prompt injection.

### Scratchpad

A shared notepad that both the user and AI can read/write. Content persists in localStorage and is always injected into the system prompt. Tools: `set_scratchpad` (replace) and `append_scratchpad` (add).

### Sandbox Mode

Ephemeral workspace with no GitHub repo. Entry via onboarding or repo picker. GitHub tools are blocked; only sandbox tools are available. 30-min container lifetime with expiry warning. Download workspace as tar.gz via header button or `sandbox_download` tool.

### Active Branch Model

There is always exactly one Active Branch per repo session — it is the commit target, push target, diff base, and chat context. Switching branches is atomic and explicit — it tears down the sandbox and creates a fresh one on the target branch (clean state, no carryover). Branch switching is available in the history drawer, home page, and workspace branch selector. Branch creation happens via the workspace/header branch action on main; on feature branches, that action becomes "Merge into main". Non-default inactive branches can be deleted from the workspace branch selector.

### Merge Flow (GitHub PR Merge)

All merges go through GitHub — Push never runs `git merge` locally. "Merge into main" is a five-step ritual: (1) check for clean working tree (commit & push if dirty), (2) find or create a Pull Request via GitHub API, (3) Auditor reviews the PR diff (`main...active`) with a SAFE/UNSAFE verdict, (4) check merge eligibility (mergeable state, CI, reviews), (5) merge via GitHub API (merge commit strategy, no fast-forward). Post-merge: user can switch to main and optionally delete the branch. Merge conflicts and branch protection are surfaced, never bypassed. PRs are only created as part of this merge ritual — no standalone "create PR" action.

### Protect Main

Optional setting that blocks direct commits to `main`, requiring a branch for all work. Configurable as a global default (on/off) plus per-repo override (inherit/always/never). Stored in localStorage via `useProtectMain` hook. No-op in Sandbox Mode.

### Branch-Scoped Chats

Conversations are permanently bound to the branch on which they were created. The history drawer groups chats by branch. Switching to a branch with existing chats lets the user resume any of them. After merge, branch chats receive a closure message; deleted branches are marked `(Merged + Deleted)` in history. Chats are never duplicated or rebound.

### Resumable Sessions

When the user locks their phone or switches apps mid-tool-loop, the app checkpoints run state to localStorage (`run_checkpoint_${chatId}`). On return, a `ResumeBanner` offers to resume. Resume revalidates sandbox/branch/repo identity, fetches `sandboxStatus()` (HEAD, dirty files, diff summary), injects a phase-specific `[SESSION_RESUMED]` reconciliation message, and re-enters the normal loop. Coder delegation state is captured via `onWorkingMemoryUpdate` callback. Multi-tab coordination uses localStorage locks (not BroadcastChannel). Checkpoint delta payload is trimmed/capped at 50KB, and resume telemetry is recorded via `getResumeEvents()`. See `documents/design/Resumable Sessions Design.md`.

### PR Awareness

Home screen shows open PR count and review-requested indicator. Chat tools include `github_list_prs`, `github_get_pr`, `github_pr_diff`, and `github_list_branches` for reading PR/branch state in any repo.

### Rolling Window

Context uses a token budget with summarization. Older tool-heavy messages are compacted first, then oldest message pairs are trimmed if needed while preserving critical context.

### Project Instructions (Two-Phase Loading)

When the user selects a repo, the app fetches project instruction files via the GitHub REST API (tries `AGENTS.md`, then `CLAUDE.md` as fallback) and injects the content into the Orchestrator and Coder system prompts. When a sandbox becomes ready later, the app re-reads from the sandbox filesystem (which may have local edits) to upgrade the content.

### Data Flow

1. **Onboard** → Connect via GitHub App (recommended) or GitHub PAT
2. **Pick repo** (or start Sandbox Mode for ephemeral workspace)
3. **Chat** → Ask about PRs, changes, codebase
4. **Tools** → JSON tool blocks → execute against GitHub API or sandbox
5. **Scratchpad** → Shared notepad for ideas/requirements (user + AI can edit)
6. **Sandbox** → Clone repo to container, run commands, edit files
7. **Coder** → Autonomous coding task execution (uses active backend)
8. **Branch** → Create branches, switch context (tears down sandbox), commit to active branch
9. **Auditor** → Every commit gets safety verdict (uses active backend)
10. **Merge** → PR creation + Auditor review + GitHub merge (merge commit strategy)
11. **Cards** → Structured results render as inline cards

## Push CLI

Local coding agent for the terminal. Same role-based agent architecture as the web app, operating directly on the filesystem instead of through a sandbox.

### Modes
*   **Interactive** (`./push`) — REPL with streaming responses, tool execution, and Ctrl+C per-prompt cancellation. High-risk commands prompt for approval.
*   **Headless** (`./push run --task "..."`) — Single task, no interaction, exits when done. `--accept <cmd>` for post-task acceptance checks. `--json` for structured output. Exit 130 on SIGINT.

### Tools

| Tool | Type | Purpose |
|------|------|---------|
| `read_file` | read | Read file with hashline-anchored line numbers |
| `list_dir` | read | List directory contents |
| `search_files` | read | Ripgrep text search (falls back to grep) |
| `web_search` | read | Search the public web (backend configurable: `auto`/`tavily`/`ollama`/`duckduckgo`) |
| `read_symbols` | read | Extract function/class/type declarations (regex) |
| `git_status` | read | Workspace git status (branch, dirty files) |
| `git_diff` | read | Show git diff (file-scoped, staged) |
| `exec` | mutate | Run a shell command |
| `write_file` | mutate | Write entire file (auto-backed up) |
| `edit_file` | mutate | Surgical hashline edits with context preview (auto-backed up) |
| `git_commit` | mutate | Stage and commit files (excludes `.push/` internal state) |
| `coder_update_state` | memory | Update working memory |

Read-only tools run in parallel per turn. Only one mutating tool allowed per turn.

### Agent Experience
*   **Workspace snapshot** in system prompt (git branch, file tree, manifest summary)
*   **Project instructions** loaded from `.push/instructions.md`, `AGENTS.md`, or `CLAUDE.md`
*   **Hashline edits** with multi-line content, edit-site context preview, automatic file backup
*   **Working memory** deduplicated (once per round), context budget tracking via `contextChars`
*   **File awareness ledger** with per-file paths and read/write status

### Safety
Workspace jail, high-risk command detection, tool loop detection, max rounds cap, output truncation. `.push/` internal state excluded from `git_commit`.

### Configuration
Config resolves: CLI flags > env vars > `~/.push/config.json` > defaults. Six providers (Ollama, Mistral, OpenRouter, Z.AI, Google, OpenCode Zen), all OpenAI-compatible SSE with retry on 429/5xx. Native function-calling override flags: `PUSH_NATIVE_FC=0|1` (CLI) and `VITE_NATIVE_FC=0|1` (web). CLI web search backend is configurable via `--search-backend`, `PUSH_WEB_SEARCH_BACKEND`, or config (`auto` default: Tavily -> Ollama native -> DuckDuckGo).

## Directory Structure

```
Push/
├── AGENTS.md              # This file — AI assistant context
├── CLAUDE.md              # Detailed architecture and conventions
├── push                   # Bash launcher (symlink-safe, POSIX-compatible)
├── wrangler.jsonc         # Cloudflare Workers config
├── app/
│   ├── worker.ts          # Cloudflare Worker — AI proxy + sandbox proxy
│   ├── src/
│   │   ├── App.tsx        # Root component, screen state machine
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, BrowserScreenshotCard, BrowserExtractCard, and more
│   │   │   ├── filebrowser/  # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # React hooks (useChat, useSandbox, useGitHubAuth, useGitHubAppAuth, useRepos, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useTavilyConfig, useUsageTracking, etc.)
│   │   ├── lib/           # Core logic, agent modules, web search, model catalog, prompts, feature flags, snapshot manager
│   │   ├── sections/      # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen
│   │   ├── types/index.ts # All shared types
│   │   └── main.tsx       # App entry point
│   ├── package.json
│   └── vite.config.ts
├── cli/
│   ├── cli.mjs               # Entrypoint — arg parsing, interactive/headless, Ctrl+C abort
│   ├── engine.mjs            # Assistant loop, working memory dedup, context budget tracking
│   ├── tools.mjs             # Tool executor, guards, hashline edits, git tools, file backup
│   ├── provider.mjs          # SSE streaming client, retry policy, abort signal merge
│   ├── workspace-context.mjs # Workspace snapshot + project instruction loading
│   ├── session-store.mjs     # Session state + event persistence
│   ├── config-store.mjs      # ~/.push/config.json read/write/env overlay
│   ├── hashline.mjs          # Hashline protocol (content-hash line refs, multi-line edits)
│   ├── file-ledger.mjs       # File awareness (per-file read/write status)
│   ├── pushd.mjs             # Daemon skeleton (Unix socket, NDJSON IPC)
│   └── tests/                # node:test suite (104 tests)
└── sandbox/
    ├── app.py             # Modal Python App — sandbox web endpoints
    └── requirements.txt
```

## Key Files Reference

### Core Logic (lib/)

| File | Purpose |
|------|---------|
| `lib/orchestrator.ts` | SSE streaming, think-token parsing, token-budget context management |
| `lib/github-tools.ts` | GitHub tool protocol, `delegate_coder`, `fetchProjectInstructions`, branch/merge/PR operations (`executeCreateBranch`, `executeCreatePR`, `executeMergePR`, `executeDeleteBranch`, `executeCheckPRMergeable`, `executeFindExistingPR`) |
| `lib/sandbox-tools.ts` | Sandbox tool definitions; includes `sandbox_edit_file` (hashline-based edits with diff output), `sandbox_read_symbols`, `sandbox_apply_patchset`, `classifyError()` (error taxonomy) |
| `lib/hashline.ts` | Hashline edit protocol — `calculateLineHash()`, `applyHashlineEdits()`, `HashlineOp`; eliminates line-number drift |
| `lib/diff-utils.ts` | Shared diff parsing — `parseDiffStats()`, `parseDiffIntoFiles()`, `formatSize()` |
| `lib/safe-storage.ts` | Safe localStorage/sessionStorage wrappers |
| `lib/edit-metrics.ts` | In-memory observability for sandbox write operations (latency, stale/error counts) |
| `lib/file-awareness-ledger.ts` | Tracks model read coverage per file (`never_read` / `partial_read` / `fully_read` / `model_authored` / `stale`) for edit safety |
| `lib/tool-call-metrics.ts` | In-memory observability for malformed tool-call attempts by provider/model/reason |
| `lib/scratchpad-tools.ts` | Scratchpad tools, prompt injection escaping |
| `lib/sandbox-client.ts` | HTTP client for `/api/sandbox/*` endpoints, `mapSandboxErrorCode()`, `sandboxStatus()` (HEAD/dirty/diff snapshot for resume reconciliation) |
| `lib/tool-dispatch.ts` | Unified dispatch for all tools, `detectAllToolCalls()` (multi-tool with read/mutate split), `isReadOnlyToolCall()` |
| `lib/coder-agent.ts` | Coder autonomous loop (uses active backend), working memory (`coder_update_state`), acceptance criteria, parallel reads, `onWorkingMemoryUpdate` callback for resumable checkpoints |
| `lib/auditor-agent.ts` | Auditor review + verdict (fail-safe, uses active backend) |
| `lib/workspace-context.ts` | Active repo context builder |
| `lib/providers.ts` | AI provider config and role model mapping |
| `lib/web-search-tools.ts` | Web search tools (Tavily, Ollama native, DuckDuckGo fallback) |
| `lib/model-catalog.ts` | Provider model lists and selection |
| `lib/prompts.ts` | Prompt building utilities |
| `lib/feature-flags.ts` | Feature flag system |
| `lib/snapshot-manager.ts` | Workspace snapshot management and recovery |
| `lib/file-processing.ts` | File content processing and transformation |
| `lib/file-utils.ts` | File utility helpers |
| `lib/sandbox-start-mode.ts` | Sandbox startup mode configuration |
| `lib/browser-metrics.ts` | Browser performance metrics tracking |
| `lib/codemirror-langs.ts` | CodeMirror language support configuration |
| `lib/codemirror-theme.ts` | CodeMirror editor theme |
| `lib/utils.ts` | General utility functions |

### Hooks (hooks/)

| File | Purpose |
|------|---------|
| `hooks/useChat.ts` | Chat state, message history, tool execution loop (multi-tool dispatch, `[meta]` envelope, structured malformed-call feedback), Coder delegation with `acceptanceCriteria`, resumable sessions (`detectInterruptedRun()`, `resumeInterruptedRun`, `dismissResume`, checkpoint persistence, multi-tab lock, `getResumeEvents()`) |
| `hooks/useSandbox.ts` | Sandbox session lifecycle |
| `hooks/useScratchpad.ts` | Shared notepad state, localStorage persistence |
| `hooks/useGitHubAuth.ts` | PAT validation, OAuth flow |
| `hooks/useRepos.ts` | Repo list fetching, activity detection |
| `hooks/useActiveRepo.ts` | Active repo selection + persistence |
| `hooks/useUserProfile.ts` | User identity (name, bio, GitHub login) + standalone getter |
| `hooks/useGitHubAppAuth.ts` | GitHub App OAuth flow and token refresh |
| `hooks/useGitHub.ts` | GitHub API client hook |
| `hooks/useFileBrowser.ts` | File browser state and navigation |
| `hooks/useCodeMirror.ts` | CodeMirror editor integration |
| `hooks/useCommitPush.ts` | Commit and push workflow state |
| `hooks/useProtectMain.ts` | Main branch protection (global default + per-repo override), localStorage persistence |
| `hooks/useOllamaConfig.ts` | Ollama backend configuration and model selection |
| `hooks/useMistralConfig.ts` | Mistral backend configuration and model selection |
| `hooks/useTavilyConfig.ts` | Tavily web search API key management |
| `hooks/useOpenRouterConfig.ts` | OpenRouter backend configuration and model selection |
| `hooks/useZaiConfig.ts` | Z.AI backend configuration and model selection |
| `hooks/useGoogleConfig.ts` | Google backend configuration and model selection |
| `hooks/useZenConfig.ts` | OpenCode Zen backend configuration and model selection |
| `hooks/useApiKeyConfig.ts` | Factory for provider API key hooks (shared localStorage getter + env var fallback + React hook) |
| `hooks/useExpandable.ts` | Generic expandable/collapsible UI state |
| `hooks/useUsageTracking.ts` | Usage analytics tracking |
| `hooks/use-mobile.ts` | Mobile viewport detection |

## Coding Conventions

- Strict TypeScript, types centralized in `types/index.ts`, discriminated unions for card types
- Functional React components with custom hooks for data fetching
- Tailwind CSS + shadcn/ui, use `cn()` for class merging
- Gate screens → `sections/`, chat UI → `components/chat/`, cards → `components/cards/`
- Agent modules in `lib/`, export a single `run*()` function
- Tool pattern: `detect*ToolCall()` → `execute*ToolCall()`, unified via `tool-dispatch.ts`
- Components: PascalCase, Hooks: `use` prefix, Types: PascalCase

## Design Principles

1. **Mobile first, not mobile friendly** — Built for phones first
2. **One app, not four** — If you leave the app to finish, it failed
3. **Chat is the interface** — Conversation is primary input
4. **Live pipeline** — Every agent step visible in real time
5. **Write-first mobile** — Auditor earns trust, not access restrictions
6. **Quiet confidence** — Fewer words, structured output
7. **Show, don't dump** — Rich inline cards over text walls

## Security Notes

- API keys never exposed to client in production (Worker proxies all AI calls)
- Auditor gate cannot be bypassed — every commit requires SAFE verdict
- Auditor defaults to UNSAFE on any error (fail-safe design)
- Repo context is hard-locked — Orchestrator only sees selected repo
- Active branch is the single context for commits, pushes, diffs, and chat — switching branches tears down the sandbox
- Chats are permanently branch-scoped — never duplicated or rebound across branches
- All merges go through GitHub PR API — no local `git merge`
- Sandbox containers auto-terminate after 30 minutes
- Browser tools validate URL shape/protocol and reject private-network targets
- Scratchpad content is escaped to prevent prompt injection (capped at 50KB)
