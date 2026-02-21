# Push

**Mobile-native AI coding agent with direct GitHub repo access.**

Push is a personal chat interface backed by role-based AI agents (Orchestrator, Coder, Auditor) designed for reviewing PRs, exploring codebases, and shipping changes from a mobile device.

## Project Overview

*   **Type:** AI Coding Agent — Mobile PWA + Local CLI
*   **Purpose:** Enable developers to manage repositories, review code, and deploy changes via a chat interface on mobile or a terminal agent locally.
*   **Core Philosophy:** Chat-first, repo-locked context, live agent pipeline, rich inline UI (cards), harness-first reliability.
*   **AI Backend:** Multi-provider support (Ollama, Mistral, OpenRouter) via OpenAI-compatible SSE streaming.

## Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React 19, TypeScript 5.9, Vite 7 |
| **Styling** | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| **Backend** | Cloudflare Workers (TypeScript) |
| **Sandbox** | Modal (Serverless Python Containers) |
| **AI Integration** | OpenAI-compatible Streaming (Ollama, Mistral, OpenRouter) |
| **APIs** | GitHub REST API |

## Architecture

### Role-Based Agents
*   **Orchestrator:** Conversational lead, interprets intent, delegates to Coder.
*   **Coder:** Autonomous code implementation and execution in the sandbox (unbounded loops, 90s timeout).
*   **Auditor:** Pre-commit safety gate. Reviews diffs and issues a binary SAFE/UNSAFE verdict.

### Key Systems
*   **Tool Protocol:** Prompt-engineered JSON tool blocks for GitHub and Sandbox interactions. Multi-tool dispatch (`detectAllToolCalls()`) splits read-only calls (parallel) from mutations (serial). Tool results include structured error fields (`error_type`, `retryable`), a `[meta]` envelope (round, context size, sandbox state), and `[TOOL_CALL_PARSE_ERROR]` headers for malformed-call feedback.
*   **Sandbox:** Persistent Linux environment (via Modal) for cloning repos, running tests, and editing files.
*   **Sandbox Mode:** Ephemeral workspace (no GitHub repo). Entry via onboarding or repo picker. GitHub tools blocked; 30-min lifetime with expiry warning. Download as tar.gz.
*   **Web Search Tools:** Mid-conversation web search via Tavily (premium), Ollama native search, or DuckDuckGo fallback. In native function-calling mode (Mistral/OpenRouter), web search is exposed via request `tools[]` (`web_search`) rather than the Mistral Agents API path.
*   **Browser Tools (Optional):** Sandbox-backed webpage screenshot + text extraction (server-side browser credentials injected by Worker).
*   **Coder Delegation:** Orchestrator delegates via `delegate_coder`. Supports `acceptanceCriteria[]` (shell commands run post-task). Coder maintains internal working memory (`CoderWorkingMemory`) via `coder_update_state` — survives context trimming.
*   **Harness Focus:** Active reliability tracks are tracked in `documents/Harness Reliability Plan.md`. Track B complete (range reads, edit guard, auto-expand). **Agent Experience Wishlist shipped** (`documents/Agent Experience Wishlist.md`): error taxonomy, structured malformed-call feedback, edit result diffs, multi-tool per turn, meta envelope, acceptance criteria, working memory, `sandbox_read_symbols`, `sandbox_apply_patchset`.
*   **User Identity:** Display name, bio, and GitHub login set in Settings. Stored in localStorage via `useUserProfile` hook. Injected into Orchestrator and Coder system prompts via `buildUserIdentityBlock()`.
*   **Scratchpad:** Shared persistent notepad for user/AI collaboration.
*   **Active Branch Model:** There is always exactly one Active Branch per repo session — commit target, push target, diff base, and chat context. Switching branches tears down the sandbox and creates a fresh one (clean state). Branch switching is available in history drawer, home page, and workspace selector. Branch creation via workspace/header action on main; feature branches show "Merge into main". Non-default inactive branches can be deleted in the workspace selector.
*   **Merge Flow (GitHub PR Merge):** All merges go through GitHub — Push never runs `git merge` locally. Five-step ritual: (1) check for clean working tree, (2) find or create PR via GitHub API, (3) Auditor reviews PR diff with SAFE/UNSAFE verdict, (4) check merge eligibility, (5) merge via GitHub API (merge commit strategy). Post-merge: switch to main, optionally delete branch. Merge conflicts and branch protection are surfaced, never bypassed.
*   **Protect Main:** Optional setting that blocks direct commits to `main`, requiring a branch for all work. Global default (on/off) plus per-repo override (inherit/always/never). Stored in localStorage via `useProtectMain` hook. No-op in Sandbox Mode.
*   **Branch-Scoped Chats:** Conversations are permanently bound to the branch on which they were created. History drawer groups chats by branch. After merge, branch chats receive a closure message; deleted branches marked `(Merged + Deleted)`.
*   **Resumable Sessions:** If the app is interrupted mid-run (phone lock/background), `useChat` checkpoints run state to localStorage (`run_checkpoint_${chatId}`) and shows a `ResumeBanner` on return. Resume validates sandbox/branch/repo identity, calls `sandboxStatus()` for HEAD/dirty/diff reconciliation, injects a phase-specific `[SESSION_RESUMED]` message, and continues the tool loop. Coder delegation state is captured via `onWorkingMemoryUpdate`. Multi-tab coordination uses localStorage locks; checkpoint delta is trimmed/capped at 50KB; resume telemetry is recorded (`getResumeEvents()`).
*   **PR Awareness:** Home screen shows open PR count and review-requested indicator. Chat tools include `github_list_prs`, `github_get_pr`, `github_pr_diff`, and `github_list_branches`.
*   **Context Management:** Token-budget rolling window with summarization.

## Push CLI

Local coding agent for the terminal. Same role-based agent architecture as the web app, operating directly on the filesystem.

### Quick Start
```bash
./push                              # interactive session
./push run --task "Fix the bug"     # headless (single task, no interaction)
./push config init                  # configure provider/model/API key
```

### Modes
*   **Interactive:** REPL with streaming responses, tool execution, and Ctrl+C per-prompt cancellation. High-risk commands prompt for approval.
*   **Headless:** Single task, exits when done. `--accept <cmd>` runs post-task acceptance checks. `--json` for structured output. Exit code 130 on SIGINT.

### Tools
| Tool | Type | Purpose |
| :--- | :--- | :--- |
| `read_file` | read | Read file with hashline-anchored line numbers |
| `list_dir` | read | List directory contents |
| `search_files` | read | Ripgrep text search (falls back to grep) |
| `read_symbols` | read | Extract function/class/type declarations (regex-based) |
| `git_status` | read | Workspace git status (branch, dirty files) |
| `git_diff` | read | Show git diff (file-scoped, staged) |
| `exec` | mutate | Run a shell command |
| `write_file` | mutate | Write entire file (auto-backed up) |
| `edit_file` | mutate | Surgical hashline edits with context preview (auto-backed up) |
| `git_commit` | mutate | Stage and commit files (excludes `.push/` internal state) |
| `coder_update_state` | memory | Update working memory |

**Read/mutate split:** Multiple read-only tools run in parallel per turn. Only one mutating tool allowed per turn.

### Agent Experience
*   **Workspace snapshot** injected into system prompt at session init (git branch, file tree, manifest summary).
*   **Project instructions** loaded from `.push/instructions.md`, `AGENTS.md`, or `CLAUDE.md`.
*   **Hashline edits** with multi-line content support, edit-site context preview, and automatic file backup before mutations.
*   **Working memory** deduplicated (injected once per round, not per tool result). Context budget tracking via `contextChars` in meta envelope.
*   **File awareness ledger** with per-file paths and read/write status.

### Safety
*   Workspace jail (no path escapes), high-risk command detection, tool loop detection, max rounds cap (default 8), output truncation (24KB).
*   `.push/` internal state (sessions, backups) excluded from `git_commit`.

### Configuration
Config resolves: CLI flags > env vars > `~/.push/config.json` > defaults. Three providers: Ollama (local), Mistral, OpenRouter. All use OpenAI-compatible SSE with retry on 429/5xx. Native function-calling override flags: `PUSH_NATIVE_FC=0|1` (CLI) and `VITE_NATIVE_FC=0|1` (web).

## Directory Structure

```
Push/
├── app/
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, BrowserScreenshotCard, BrowserExtractCard, and more
│   │   │   ├── filebrowser/ # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/        # shadcn/ui library
│   │   ├── hooks/         # React hooks (useChat, useSandbox, useGitHubAuth, useGitHubAppAuth, useUserProfile, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useTavilyConfig, useUsageTracking, etc.)
│   │   ├── lib/           # Core Logic
│   │   │   ├── orchestrator.ts    # Agent coordination & streaming
│   │   │   ├── coder-agent.ts     # Coder sub-agent loop, working memory, acceptance criteria, onWorkingMemoryUpdate
│   │   │   ├── auditor-agent.ts   # Auditor safety gate
│   │   │   ├── github-tools.ts    # GitHub API tools, branch/merge/PR operations
│   │   │   ├── sandbox-tools.ts   # Sandbox tools, error taxonomy, sandbox_read_symbols, sandbox_apply_patchset
│   │   │   ├── sandbox-client.ts  # Sandbox HTTP client, mapSandboxErrorCode(), sandboxStatus() for resume reconciliation
│   │   │   ├── tool-dispatch.ts   # Unified dispatch, detectAllToolCalls(), multi-tool support
│   │   │   ├── web-search-tools.ts # Web search (Tavily, Ollama native, DuckDuckGo)
│   │   │   ├── model-catalog.ts   # Ollama/Mistral model lists
│   │   │   ├── prompts.ts         # Prompt building utilities
│   │   │   ├── feature-flags.ts   # Feature flag system
│   │   │   ├── snapshot-manager.ts # Workspace snapshot management
│   │   │   └── ...                # file-processing, file-utils, browser-metrics, codemirror-*, utils
│   │   ├── sections/      # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen
│   │   ├── types/         # Shared TypeScript definitions
│   │   ├── App.tsx        # Main entry & routing
│   │   └── main.tsx       # React root
│   ├── worker.ts          # Cloudflare Worker (AI & Sandbox Proxy)
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
│   └── tests/                # node:test suite (104 tests)
├── sandbox/
│   ├── app.py             # Modal Python App (Sandbox Endpoints)
│   └── requirements.txt   # Python dependencies
├── push                   # Bash launcher (symlink-safe, POSIX-compatible)
├── AGENTS.md              # AI Agent Context & Instructions
├── CLAUDE.md              # Detailed Architecture Docs
├── wrangler.jsonc         # Cloudflare Workers Configuration
└── README.md              # Project Documentation
```

## Development & Usage

### Prerequisites
*   Node.js & npm
*   Python (for Modal sandbox deployment)
*   API Keys: Ollama/Mistral/OpenRouter (AI), GitHub (Auth/API)

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
Environment variables are in `app/.env` (local dev) and Cloudflare Worker secrets (production). API keys can also be set via the Settings UI.

Key variables: `VITE_MISTRAL_API_KEY` (Mistral), `VITE_OLLAMA_API_KEY` (Ollama Cloud), `VITE_OPENROUTER_API_KEY` (OpenRouter), `VITE_TAVILY_API_KEY` (web search), `VITE_GITHUB_TOKEN` (PAT), `VITE_GITHUB_CLIENT_ID` / `VITE_GITHUB_APP_REDIRECT_URI` / `VITE_GITHUB_OAUTH_PROXY` / `VITE_GITHUB_REDIRECT_URI` (GitHub App OAuth), `VITE_BROWSER_TOOL_ENABLED` (browser tools toggle), `VITE_NATIVE_FC` (web native FC override: `0|1`), `PUSH_NATIVE_FC` (CLI native FC override: `0|1`).

## Coding Conventions
*   **TypeScript:** Strict mode enabled. Explicit return types required on exported functions.
*   **Styling:** Use Tailwind CSS via `cn()` utility for class merging.
*   **Components:** Functional components with hooks. PascalCase naming.
*   **State:** Custom hooks for logic encapsulation (`useChat`, `useSandbox`).
*   **Branching:** Active branch is the single context for commits, pushes, diffs, and chat. Chats are permanently branch-scoped. All merges go through GitHub PR API.
*   **Safety:** Auditor defaults to UNSAFE on error. Secrets managed via Cloudflare Worker.
