# Push

**Mobile-native AI coding agent with direct GitHub repo access.**

Push is a personal AI coding notebook backed by role-based AI agents (Orchestrator, Coder, Reviewer, Auditor) designed for reviewing PRs, exploring codebases, and shipping changes from a mobile device.

## Project Overview

*   **Type:** AI Coding Agent — Mobile PWA + Local CLI
*   **Purpose:** Enable developers to manage repositories, review code, and deploy changes via a chat interface on mobile or a terminal agent locally.
*   **Core Philosophy:** Chat-first, repo-locked context, live agent pipeline, rich inline UI (cards), harness-first reliability.
*   **AI Backend:** The web app ships with four built-in providers (Ollama, OpenRouter, OpenCode Zen, Nvidia NIM) plus opt-in private connectors for Azure OpenAI, AWS Bedrock, and Google Vertex. The built-ins, Azure, and Bedrock use OpenAI-compatible SSE streaming. Vertex now uses a Google service account JSON plus region and model in the normal path, routes Gemini through Vertex OpenAPI, routes Claude through Vertex's Anthropic partner-model API, and translates the result back into the app's OpenAI-style SSE stream; legacy raw Vertex OpenAPI config still works as a fallback. Settings stores default backend/model picks and the app's active backend preference, chat keeps its own current selection, delegated Coder runs inherit that chat lock, Reviewer keeps its own sticky provider/model selection, and Auditor now follows the same chat lock when available. After the first user message, a chat's provider/model are locked and changing either starts a new chat.
*   **Current Product Focus:** CLI/TUI terminal UX improvements, with most active terminal work going into the full-screen TUI while REPL and headless flows remain supported.

## Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 19, TypeScript 5.9, Vite 7 |
| **Styling** | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| **Backend** | Cloudflare Workers (TypeScript) |
| **Sandbox** | Modal (Serverless Python Containers) |
| **AI Integration** | OpenAI-compatible streaming for built-ins plus Azure/Bedrock private connectors; native Google Vertex service-account flow for Gemini and Claude |
| **APIs** | GitHub REST API |

## Architecture

### Role-Based Agents
*   **Orchestrator:** Conversational lead, interprets intent, delegates to Coder.
*   **Coder:** Autonomous code implementation and execution in the sandbox (up to 30 rounds, 60s inactivity timeout per round, ~120k-char context cap).
*   **Reviewer:** On-demand advisory diff review in the Workspace Hub. Can review Branch diff, Last commit, or Working tree changes, send findings into chat as fix requests, and post PR-backed Branch diff reviews to GitHub.
*   **Auditor:** Pre-commit safety gate. Reviews diffs and issues a binary SAFE/UNSAFE verdict.

### Key Systems
*   **Tool Protocol:** Prompt-engineered JSON tool blocks for GitHub and Sandbox interactions. Multi-tool dispatch (`detectAllToolCalls()`) splits read-only calls (parallel) from mutations (serial). Tool results include structured error fields (`error_type`, `retryable`), a `[meta]` envelope (round, context size, sandbox state), and `[TOOL_CALL_PARSE_ERROR]` headers for malformed-call feedback.
*   **Sandbox:** Persistent Linux environment (via Modal) for cloning repos, running tests, and editing files.
*   **Scratch Workspace:** Ephemeral workspace (no GitHub repo). Entry via onboarding or the launcher/home surface. GitHub tools blocked; 30-min lifetime with expiry warning. Download as tar.gz.
*   **Web Search Tools:** Mid-conversation web search via Tavily (premium), Ollama native search, or DuckDuckGo fallback. Prompt-engineered JSON format, client-side dispatch.
*   **Coder Delegation:** Orchestrator delegates via `delegate_coder`. Supports `acceptanceCriteria[]` (shell commands run post-task). Coder maintains internal working memory (`CoderWorkingMemory`) via `coder_update_state` — survives context trimming.
*   **Reviewer:** The Workspace Hub `Review` tab has three sources: `Branch diff` reviews the pushed branch against the default branch or the open PR diff without starting a sandbox, `Last commit` reviews the diff of the most recent pushed commit on the active branch, and `Working tree` reviews uncommitted sandbox edits. It adds line anchors when possible, can jump findings into Diff or chat, and only PR-backed Branch diff reviews can be posted back as a GitHub PR review.
*   **Harness Priority:** Push still prioritizes harness reliability over model churn, but the major checklist is shipped. `documents/plans/Harness Reliability Plan.md` is now reference/planning history rather than an active checklist in the product docs. **Agent Experience Wishlist shipped** (`documents/analysis/Agent Experience Wishlist.md`): error taxonomy, structured malformed-call feedback, edit result diffs, multi-tool per turn, meta envelope, acceptance criteria, working memory, `sandbox_read_symbols`, `sandbox_apply_patchset`, plus edit convenience wrappers (`sandbox_edit_range`, `sandbox_search_replace`) on top of hashline editing.
*   **User Identity:** Display name, bio, and GitHub login set in Settings. Stored in localStorage via `useUserProfile` hook. Injected into Orchestrator and Coder system prompts via `buildUserIdentityBlock()`.
*   **Scratchpad:** Shared persistent notepad for user/AI collaboration.
*   **Active Branch Model:** There is always exactly one Active Branch per repo session — commit target, push target, diff base, and chat context. Switching branches tears down the sandbox and creates a fresh one (clean state). Branch switching is available in history drawer, launcher/home, and the workspace selector. Branch creation is an explicit UI action available from the launcher/home surface and the Workspace Hub commit/push sheet; the assistant does not create branches itself. The Workspace Hub is the coding notebook for the active branch. Feature branches show "Merge into main" as the primary workspace action. Non-default inactive branches can be deleted in the workspace selector.
*   **Merge Flow (GitHub PR Merge):** All merges go through GitHub — Push never runs `git merge` locally. Five-step ritual: (1) check for clean working tree, (2) find or create PR via GitHub API, (3) Auditor reviews PR diff with SAFE/UNSAFE verdict, (4) check merge eligibility, (5) merge via GitHub API (merge commit strategy). Post-merge: switch to main, optionally delete branch. Merge conflicts and branch protection are surfaced, never bypassed.
*   **Protect Main:** Optional setting that blocks direct commits to `main`, requiring a branch for all work. Global default (on/off) plus per-repo override (inherit/always/never). Stored in localStorage via `useProtectMain` hook. No-op in scratch workspaces.
*   **Branch-Scoped Chats:** Conversations are permanently bound to the branch on which they were created. History drawer groups chats by branch. After merge, branch chats receive a closure message; deleted branches marked `(Merged + Deleted)`.
*   **Resumable Sessions:** If the app is interrupted mid-run (phone lock/background), `useChat` checkpoints run state to localStorage (`run_checkpoint_${chatId}`) and shows a `ResumeBanner` on return. Resume validates sandbox/branch/repo identity, calls `sandboxStatus()` for HEAD/dirty/diff reconciliation, injects a phase-specific `[SESSION_RESUMED]` message, and continues the tool loop. Coder delegation state is captured via `onWorkingMemoryUpdate`. Multi-tab coordination uses localStorage locks; checkpoint delta is trimmed/capped at 50KB; resume telemetry is recorded (`getResumeEvents()`).
*   **PR Awareness:** The launcher/home surface shows repo activity, including open PR counts and recent activity markers. Chat tools include `github_list_prs`, `github_get_pr`, `github_pr_diff`, and `github_list_branches`. The Workspace Hub `Review` tab can review the active branch or latest commit directly from GitHub without a sandbox, send findings into chat as fix requests, and, when a Branch diff review resolves to an open PR, post Reviewer findings back to GitHub.
*   **Context Management:** Token-budget rolling window with summarization.

## Push CLI

Local coding agent for the terminal. Same role-based agent architecture as the web app, operating directly on the filesystem.

Current roadmap focus is the full-screen TUI and surrounding terminal/session ergonomics around `push`, while keeping the classic REPL and `push run` flow working.

### Quick Start
```bash
PUSH_TUI_ENABLED=1 ./push           # TUI
./push run --task "Fix the bug"     # headless (single task, no interaction)
./push config init                  # configure provider/model/API key
```

### Modes
*   **TUI:** Full-screen terminal UI. Bare `./push` opens it when `PUSH_TUI_ENABLED=1`.
*   **Interactive fallback:** REPL when TUI is disabled; same streaming tool loop and approval flow.
*   **Headless:** Single task, exits when done. `--accept <cmd>` runs post-task acceptance checks. `--json` for structured output. Exit code 130 on SIGINT.

### Tools
| Tool | Type | Purpose |
| :--- | :--- | :--- |
| `read_file` | read | Read file with hashline-anchored line numbers |
| `list_dir` | read | List directory contents |
| `search_files` | read | Ripgrep text search (falls back to grep) |
| `web_search` | read | Search the public web (backend configurable: `auto`/`tavily`/`ollama`/`duckduckgo`) |
| `read_symbols` | read | Extract function/class/type declarations (regex-based) |
| `git_status` | read | Workspace git status (branch, dirty files) |
| `git_diff` | read | Show git diff (file-scoped, staged) |
| `exec` | mutate | Run a shell command |
| `exec_start` | mutate | Start a long-running command session |
| `exec_poll` | read | Read incremental output from a command session |
| `exec_write` | mutate | Send stdin input to a running command session |
| `exec_stop` | mutate | Stop a command session |
| `exec_list_sessions` | read | List command sessions and status |
| `write_file` | mutate | Write entire file (auto-backed up) |
| `edit_file` | mutate | Surgical hashline edits with context preview (auto-backed up) |
| `undo_edit` | mutate | Restore a file from the most recent tool-created backup |
| `git_commit` | mutate | Stage and commit files (excludes `.push/` internal state) |
| `lsp_diagnostics` | read | Run workspace diagnostics/type-check output |
| `save_memory` | memory | Persist concise project learnings across sessions (`.push/memory.md`) |
| `coder_update_state` | memory | Update working memory |
| `ask_user` | control | Pause for operator clarification when a critical ambiguity would waste work |

**Read/mutate split:** Multiple read-only tools run in parallel per turn. Only one mutating tool is allowed per turn; memory/control tools do not modify workspace files.

### Agent Experience
*   **Workspace snapshot** injected into system prompt at session init (git branch, file tree, manifest summary).
*   **Project instructions** loaded from `.push/instructions.md`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`.
*   **Hashline edits** with multi-line content support, edit-site context preview, and automatic file backup before mutations.
*   **Working memory** deduplicated (injected once per round, not per tool result). Context budget tracking via `contextChars` in meta envelope.
*   **File awareness ledger** with per-file paths and read/write status.

### Safety
*   Workspace jail (no path escapes), high-risk command detection, tool loop detection, max rounds cap (default 8), output truncation (24KB).
*   `.push/` internal state (sessions, backups) excluded from `git_commit`.

### Configuration
Config resolves: CLI flags > env vars > `~/.push/config.json` > defaults. Four providers: Ollama, OpenRouter, OpenCode Zen, Nvidia NIM. All use OpenAI-compatible SSE with retry on 429/5xx. All tools are prompt-engineered (JSON blocks in model output, client-side dispatch). CLI web search backend is configurable via `--search-backend`, `PUSH_WEB_SEARCH_BACKEND`, or config (`auto` default: Tavily -> Ollama native -> DuckDuckGo).

## Directory Structure

```
Push/
├── app/
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, and more
│   │   │   ├── filebrowser/ # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/        # shadcn/ui library
│   │   ├── hooks/         # React hooks (useChat, useSandbox, useGitHubAuth, useGitHubAppAuth, useUserProfile, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useVertexConfig, useTavilyConfig, useUsageTracking, etc.)
│   │   ├── lib/           # Core Logic
│   │   │   ├── orchestrator.ts    # Agent coordination & streaming
│   │   │   ├── coder-agent.ts     # Coder sub-agent loop, working memory, acceptance criteria, onWorkingMemoryUpdate
│   │   │   ├── reviewer-agent.ts  # Reviewer advisory diff review + line anchors
│   │   │   ├── auditor-agent.ts   # Auditor safety gate
│   │   │   ├── github-tools.ts    # GitHub API tools, branch/merge/PR operations
│   │   │   ├── sandbox-tools.ts   # Sandbox tools, error taxonomy, sandbox_edit_range, sandbox_search_replace, sandbox_read_symbols, sandbox_apply_patchset
│   │   │   ├── sandbox-client.ts  # Sandbox HTTP client, mapSandboxErrorCode(), sandboxStatus() for resume reconciliation
│   │   │   ├── tool-dispatch.ts   # Unified dispatch, detectAllToolCalls(), multi-tool support
│   │   │   ├── web-search-tools.ts # Web search (Tavily, Ollama native, DuckDuckGo)
│   │   │   ├── model-catalog.ts   # Provider model lists and selection
│   │   │   ├── vertex-provider.ts # Google Vertex model catalog, service-account helpers, native endpoints
│   │   │   ├── prompts.ts         # Prompt building utilities
│   │   │   ├── snapshot-manager.ts # Workspace snapshot management
│   │   │   └── ...                # file-processing, file-utils, codemirror-*, utils
│   │   ├── sections/      # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen
│   │   ├── types/         # Shared TypeScript definitions
│   │   ├── App.tsx        # Main entry & routing
│   │   └── main.tsx       # React root
│   ├── worker.ts          # Cloudflare Worker (AI, native Vertex adapter, and Sandbox Proxy)
│   ├── package.json       # Frontend dependencies & scripts
│   ├── tsconfig.json      # TypeScript configuration
│   └── vite.config.ts     # Vite configuration
├── cli/
│   ├── cli.mjs               # Entrypoint — arg parsing, interactive/headless dispatch
│   ├── engine.mjs            # Assistant loop, working memory, multi-tool dispatch, context tracking
│   ├── tools.mjs             # Tool executor, workspace guard, hashline edits, git tools, risk detection
│   ├── provider.mjs          # SSE streaming client, retry policy, provider configs
│   ├── workspace-context.mjs # Workspace snapshot + project instruction loading
│   ├── session-store.mjs     # Session state + event persistence
│   ├── config-store.mjs      # ~/.push/config.json read/write/env overlay
│   ├── hashline.mjs          # Hashline protocol (content-hash line refs, multi-line edits)
│   ├── file-ledger.mjs       # File awareness tracking (per-file read/write status)
│   ├── tool-call-metrics.mjs # Malformed tool-call counters
│   ├── pushd.mjs             # Daemon skeleton (Unix socket, NDJSON IPC)
│   ├── AGENT-WISHLIST.md     # Agent experience wishlist (shipped)
│   └── tests/                # node:test suite
├── sandbox/
│   ├── app.py             # Modal Python App (Sandbox Endpoints)
│   └── requirements.txt   # Python dependencies
├── push                   # Bash launcher (symlink-safe, POSIX-compatible)
├── AGENTS.md              # AI Agent Context & Instructions
├── CLAUDE.md              # Detailed Architecture Docs
├── GEMINI.md              # Gemini-facing project context
├── wrangler.jsonc         # Cloudflare Workers Configuration
└── README.md              # Project Documentation
```

## Development & Usage

### Prerequisites
*   Node.js & npm
*   Python (for Modal sandbox deployment)
*   API Keys: Ollama/OpenRouter/Zen/Nvidia (AI), optional Google Vertex service account JSON, GitHub (Auth/API)

### Setup & Run
1.  **Install Frontend Dependencies:**
    ```bash
    cd app
    npm install
    ```
2.  **Start Development Server:**
    ```bash
    npm run dev
    ```
3.  **Build for Production:**
    ```bash
    npm run build
    ```

### Deployment
*   **Cloudflare Worker:** `npx wrangler deploy` (from repo root)
*   **Modal Sandbox:** `cd sandbox && python -m modal deploy app.py`

### Environment
Environment variables are in `app/.env` (local dev) and Cloudflare Worker secrets (production). API keys can also be set via the Settings UI. When no GitHub token is configured, repo and PR views fall back to mock/demo data. In local development, with no AI keys configured, the app uses the demo-provider path.

Key variables: `VITE_OLLAMA_API_KEY` (Ollama Cloud), `VITE_OPENROUTER_API_KEY` (OpenRouter), `VITE_ZEN_API_KEY` (OpenCode Zen), `VITE_NVIDIA_API_KEY` (Nvidia NIM), `VITE_VERTEX_SERVICE_ACCOUNT_JSON` / `VITE_VERTEX_REGION` / `VITE_VERTEX_MODEL` (Google Vertex native config), `VITE_TAVILY_API_KEY` (web search), `VITE_GITHUB_TOKEN` (PAT), `VITE_GITHUB_CLIENT_ID` / `VITE_GITHUB_APP_REDIRECT_URI` / `VITE_GITHUB_OAUTH_PROXY` / `VITE_GITHUB_REDIRECT_URI` (GitHub App OAuth), `PUSH_WEB_SEARCH_BACKEND` (CLI web search backend override).

## Coding Conventions
*   **TypeScript:** Strict mode enabled. Explicit return types required on exported functions.
*   **Styling:** Use Tailwind CSS via `cn()` utility for class merging.
*   **Components:** Functional components with hooks. PascalCase naming.
*   **State:** Custom hooks for logic encapsulation (`useChat`, `useSandbox`).
*   **Branching:** Active branch is the single context for commits, pushes, diffs, and chat. Chats are permanently branch-scoped. All merges go through GitHub PR API.
*   **Safety:** Auditor defaults to UNSAFE on error. Secrets managed via Cloudflare Worker.
