# Push — Mobile AI Coding Agent

ChatGPT with direct access to your repos. A personal, mobile-first chat interface backed by role-based AI agents that can read your code, write patches, run them in a sandbox, and commit/push changes.

## Quick Start

```bash
cd app
npm install
npm run dev
```

## Tech Stack

- React 19 + TypeScript 5.9 + Vite 7
- Tailwind CSS 3 + shadcn/ui (Radix primitives)
- GitHub REST API for repo operations
- **Multi-backend AI** (user picks in Settings):
  - Kimi For Coding (Kimi K2.5 via api.kimi.com, OpenAI-compatible SSE)
  - Ollama Cloud (open models on cloud GPUs via ollama.com, OpenAI-compatible SSE)
  - Mistral Vibe (Devstral via api.mistral.ai, OpenAI-compatible SSE)
  - Z.ai (GLM via api.z.ai, OpenAI-compatible SSE)
- Modal (serverless containers) for sandbox code execution
- Cloudflare Workers (streaming proxy + sandbox proxy)
- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. The user never picks a model — they pick a backend.

- **Orchestrator** — Conversational lead, interprets user intent, coordinates specialists, assembles results. The voice of the app.
- **Coder** — Code implementation and execution engine. Writes, edits, and runs code in a sandbox.
- **Auditor** — Risk specialist, pre-commit gate, binary verdict. Cannot be bypassed.

**AI backends:** Four providers — **Kimi For Coding** (`api.kimi.com`), **Ollama Cloud** (`ollama.com`), **Mistral Vibe** (`api.mistral.ai`), and **Z.ai** (`api.z.ai`). All use OpenAI-compatible SSE streaming. API keys are configurable at runtime via Settings UI. The active backend serves all three roles. Provider selection is locked per chat after the first user message. Default Ollama model is `gemini-3-flash-preview`. Default Mistral model is `devstral-small-latest`.

**Onboarding & state machine:** Users connect with GitHub App (recommended) or GitHub PAT, then select an active repo before chatting. Demo mode is an escape hatch with mock data. Sandbox Mode lets users start an ephemeral workspace without any GitHub auth. State machine: `onboarding → repo-picker → chat` (plus `file-browser` when sandbox files are open). The `isSandboxMode` flag bypasses auth and repo selection.

**Tool protocol:** Tools are prompt-engineered — the system prompt defines available tools and JSON format. The orchestrator detects JSON tool blocks in responses, executes them against GitHub's API, injects results as synthetic messages, and re-calls the LLM. Both the Orchestrator and Coder tool loops are unbounded — they continue until the model stops emitting tool calls (or the user aborts). Sandbox tools use the same JSON block pattern, detected by a unified tool dispatch layer.

**Browser tools (optional):** `sandbox_browser_screenshot` and `sandbox_browser_extract`, prompt-gated by `VITE_BROWSER_TOOL_ENABLED=true`, routed through Worker endpoints. The Worker injects Browserbase credentials server-side.

**Web search tools:** The Orchestrator can search the web mid-conversation via `web-search-tools.ts`. Three backends: **Tavily** (premium, LLM-optimized results via `VITE_TAVILY_API_KEY`), **Ollama native search** (POST `/api/web_search`), and **DuckDuckGo** (free fallback). Mistral handles search natively via its Agents API. API keys are configurable at runtime via Settings.

**Sandbox:** Modal (serverless containers) provides a persistent Linux environment per session. The repo is cloned into `/workspace` (or an empty workspace is created in Sandbox Mode). The Coder reads/writes files, runs commands, and gets diffs — all via sandbox tools. The Cloudflare Worker proxies sandbox requests to Modal web endpoints (keeps Modal auth server-side). Containers auto-terminate after 30 min.

**Sandbox Mode:** Ephemeral workspace with no GitHub repo. Entry via onboarding ("Try it now") or repo picker ("New Sandbox"). GitHub tools are blocked; only sandbox tools are available. Expiry warning at 5 min remaining. Download via header button, expiry banner, or `sandbox_download` AI tool (tar.gz archive). See `documents/Sandbox mode.md` for full spec.

**Coder delegation:** The Orchestrator can delegate coding tasks to the Coder via `delegate_coder`. The Coder runs autonomously with its own tool loop in the sandbox (unbounded rounds, 90s timeout per round, 60KB context cap), then returns a summary + cards to the Orchestrator.

**Auditor gate:** Every `sandbox_commit` runs through the Auditor first. The Auditor reviews the diff and returns a binary verdict (SAFE/UNSAFE). UNSAFE blocks the commit. The Auditor defaults to UNSAFE on any error (fail-safe).

**Repo hard lock:** The Orchestrator only sees the active repo in its context. Other repos are stripped entirely. Repo switching is UI-only via the header dropdown.

**User identity:** Users can set a display name, bio, and GitHub login in Settings (About You tab). Stored in localStorage via `useUserProfile` hook (standalone getter + React hook pattern). Injected into both Orchestrator and Coder system prompts via `buildUserIdentityBlock()` in orchestrator.ts. Bio content is escaped to prevent prompt injection via identity block boundaries.

**Scratchpad:** A shared notepad that both the user and the LLM can read/write. User opens via button in ChatInput, the LLM updates via `set_scratchpad` / `append_scratchpad` tools. Content persists in localStorage and is always injected into the system prompt. Content is escaped to prevent prompt injection.

**Rolling window:** Context is managed by token budget, not fixed message count. The app summarizes older tool-heavy messages first, then trims oldest message pairs if still over budget, while keeping tool call/result pairs together.

**Active Branch model:** There is always exactly one Active Branch per repo session. It is the sandbox branch, chat context branch, commit target, push target, and diff base. Switching branches is atomic and explicit — it tears down the current sandbox and creates a fresh one on the target branch (clean state, no carryover). Branch switching is available in the history drawer and home page. Branch creation happens only via the header "Create Branch" action (available on main). On feature branches, the header shows "Merge into main" instead.

**Merge flow (GitHub PR merge):** All merges go through GitHub — Push never runs `git merge` locally. "Merge into main" is a five-step ritual: (1) check for clean working tree (commit & push if dirty), (2) find or create a Pull Request via GitHub API, (3) Auditor reviews the PR diff (`main...active`) with a SAFE/UNSAFE verdict, (4) check merge eligibility (mergeable state, CI, reviews), (5) merge via GitHub API (merge commit strategy, no fast-forward). Post-merge: user can switch to main and optionally delete the branch. Merge conflicts and branch protection are surfaced, never bypassed. PRs are only created as part of this merge ritual — no standalone "create PR" action.

**Protect Main:** Optional setting that blocks direct commits to `main`, requiring a branch for all work. Configurable as a global default (on/off) plus per-repo override (inherit/always/never). Stored in localStorage via `useProtectMain` hook. No-op in Sandbox Mode.

**Branch-scoped chats:** Conversations are permanently bound to the branch on which they were created. The history drawer groups chats by branch. Switching to a branch with existing chats lets the user resume any of them. After merge, branch chats receive a closure message; deleted branches are marked `(Merged + Deleted)` in history. Chats are never duplicated or rebound.

**PR awareness:** Home screen shows open PR count and review-requested indicator. Chat tools include `github_list_prs`, `github_get_pr`, `github_pr_diff`, and `github_list_branches` for reading PR/branch state in any repo.

**Project instructions (two-phase loading):** When the user selects a repo, the app immediately fetches `AGENTS.md` (or `CLAUDE.md` as fallback) via the GitHub REST API and injects it into the Orchestrator's system prompt and the Coder's context. When a sandbox becomes ready later, the app re-reads from the sandbox filesystem (which may have local edits) and upgrades the content. This ensures all agents have project context from the first message, not just after sandbox spin-up.

## Project Layout

```
app/src/
  components/chat/        # Chat UI (ChatContainer, ChatInput, MessageBubble, AgentStatusBar, AttachmentPreview, ContextMeter, WorkspacePanel, WorkspacePanelButton, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet)
  components/cards/       # Rich inline cards (PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, SandboxDownloadCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, EditorPanel, FileCard, FileListCard, BrowserExtractCard, BrowserScreenshotCard, BranchListCard, CIStatusCard, CommitListCard, CommitFilesCard, PRListCard, TypeCheckCard, WorkflowRunsCard, WorkflowLogsCard, SandboxStateCard, CardRenderer)
  components/filebrowser/ # File browser UI (FileActionsSheet, CommitPushSheet, FileEditor, UploadButton)
  components/ui/          # shadcn/ui component library
  hooks/                  # React hooks (useChat, useGitHubAuth, useGitHubAppAuth, useGitHub, useRepos, useActiveRepo, useSandbox, useScratchpad, useUserProfile, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useOllamaConfig, useMoonshotKey, useMistralConfig, useTavilyConfig, useUsageTracking, use-mobile)
  lib/                    # Orchestrator, tool protocol, sandbox client, agent modules, workspace context, web search, model catalog, prompts, feature flags, snapshot manager
  sections/               # Screen components (OnboardingScreen, RepoPicker, FileBrowser, HomeScreen)
  types/                  # TypeScript type definitions
  App.tsx                 # Root component, screen state machine
app/worker.ts        # Cloudflare Worker — streaming proxy to Kimi/Ollama/Mistral/Z.ai + sandbox proxy to Modal
sandbox/app.py       # Modal Python App — sandbox web endpoints (file ops, exec/git, browser tools, archive download)
sandbox/requirements.txt
wrangler.jsonc       # Cloudflare Workers config (repo root)
```

## Key Files

- `lib/orchestrator.ts` — System prompt, multi-backend streaming (Kimi + Ollama + Mistral + Z.ai SSE), think-token parsing, provider routing, token-budget context management, `buildUserIdentityBlock()` (user identity injection)
- `lib/github-tools.ts` — GitHub tool protocol (prompt-engineered function calling via JSON blocks), `delegate_coder`, `fetchProjectInstructions` (reads AGENTS.md/CLAUDE.md from repos via API), branch/merge/PR operations (`executeCreateBranch`, `executeCreatePR`, `executeMergePR`, `executeDeleteBranch`, `executeCheckPRMergeable`, `executeFindExistingPR`)
- `lib/sandbox-tools.ts` — Sandbox tool definitions, detection, execution, `SANDBOX_TOOL_PROTOCOL` prompt
- `lib/sandbox-client.ts` — HTTP client for `/api/sandbox/*` endpoints (thin fetch wrappers)
- `lib/scratchpad-tools.ts` — Scratchpad tool definitions (`set_scratchpad`, `append_scratchpad`), prompt injection escaping
- `lib/tool-dispatch.ts` — Unified tool dispatch (GitHub + Sandbox + Scratchpad + delegation)
- `lib/coder-agent.ts` — Coder sub-agent loop (unbounded rounds, 90s timeout per round, uses active backend)
- `lib/auditor-agent.ts` — Auditor review + verdict (fail-safe to UNSAFE, uses active backend)
- `lib/workspace-context.ts` — Builds active repo context for system prompt injection
- `lib/providers.ts` — AI provider configs (Kimi + Ollama + Mistral + Z.ai), role-to-model mapping, backend preference
- `lib/web-search-tools.ts` — Web search tool definitions (Tavily, Ollama native search, DuckDuckGo fallback; Mistral handles search natively via Agents API)
- `lib/model-catalog.ts` — Manages Ollama/Mistral model lists and selection (Z.ai currently uses default model)
- `lib/prompts.ts` — Prompt building utilities
- `lib/feature-flags.ts` — Feature flag system
- `lib/snapshot-manager.ts` — Workspace snapshot management and recovery
- `lib/file-processing.ts` — File content processing and transformation
- `lib/file-utils.ts` — File utility helpers
- `lib/sandbox-start-mode.ts` — Sandbox startup mode configuration
- `lib/browser-metrics.ts` — Browser performance metrics tracking
- `lib/codemirror-langs.ts` — CodeMirror language support configuration
- `lib/codemirror-theme.ts` — CodeMirror editor theme
- `lib/utils.ts` — General utility functions
- `hooks/useChat.ts` — Chat state, message history, unified tool execution loop, Coder delegation, scratchpad integration
- `hooks/useUserProfile.ts` — User identity (name, bio, GitHub login), standalone getter + React hook, localStorage persistence
- `hooks/useSandbox.ts` — Sandbox session lifecycle (idle → creating → ready → error), supports ephemeral mode
- `hooks/useScratchpad.ts` — Shared notepad state, localStorage persistence, content size limits
- `hooks/useGitHubAuth.ts` — PAT validation, OAuth flow, mount re-validation
- `hooks/useGitHubAppAuth.ts` — GitHub App OAuth flow and token refresh
- `hooks/useGitHub.ts` — GitHub API client hook
- `hooks/useActiveRepo.ts` — Active repo selection + localStorage persistence
- `hooks/useRepos.ts` — Repo list fetching, sync tracking, activity detection
- `hooks/useFileBrowser.ts` — File browser state and navigation
- `hooks/useCodeMirror.ts` — CodeMirror editor integration
- `hooks/useCommitPush.ts` — Commit and push workflow state
- `hooks/useProtectMain.ts` — Main branch protection (global default + per-repo override), localStorage persistence, standalone getter + React hook
- `hooks/useOllamaConfig.ts` — Ollama backend configuration and model selection
- `hooks/useMoonshotKey.ts` — Kimi/Moonshot API key management
- `hooks/useMistralConfig.ts` — Mistral backend configuration and model selection
- `hooks/useZaiConfig.ts` — Z.ai backend configuration
- `hooks/useTavilyConfig.ts` — Tavily web search API key management
- `hooks/useUsageTracking.ts` — Usage analytics tracking
- `hooks/use-mobile.ts` — Mobile viewport detection
- `types/index.ts` — All shared TypeScript types (includes card data types for sandbox, diff preview, audit verdict)

## Environment

Environment variables are defined in `app/.env` (local dev) and Cloudflare Worker secrets (production). API keys can also be set via the Settings UI at runtime. Without any API keys the app runs in demo mode with mock data.

Key variables: `VITE_MOONSHOT_API_KEY` (Kimi), `VITE_MISTRAL_API_KEY` (Mistral), `VITE_OLLAMA_API_KEY` (Ollama Cloud), `VITE_ZAI_API_KEY` (Z.ai), `VITE_TAVILY_API_KEY` (web search), `VITE_GITHUB_TOKEN` (PAT), `VITE_GITHUB_CLIENT_ID` / `VITE_GITHUB_APP_REDIRECT_URI` / `VITE_GITHUB_OAUTH_PROXY` / `VITE_GITHUB_REDIRECT_URI` (GitHub App OAuth), `VITE_BROWSER_TOOL_ENABLED` (browser tools toggle).

## Design Principles

1. Mobile first, not mobile friendly
2. One app, not four — if you leave the app to finish the job, the app failed
3. Chat is the interface — conversation is the primary input
4. Live pipeline — every agent step visible in real time, Manus-style
5. Write-first mobile — Auditor earns trust, not access restrictions
6. Quiet confidence — fewer words, structured output, no over-explaining
7. Show, don't dump — rich inline cards instead of walls of text

## Conventions

- Gate screens go in `sections/`, chat components in `components/chat/`, inline cards in `components/cards/`, file browser components in `components/filebrowser/`
- API clients and orchestration logic go in `lib/`
- Agent modules (coder-agent, auditor-agent) go in `lib/` and export a single `run*()` function
- Hooks encapsulate all data fetching and state for a concern
- Types are centralized in `types/index.ts`
- Tool detection/execution follows the pattern: `detect*ToolCall()` → `execute*ToolCall()`, unified via `tool-dispatch.ts`
- Demo mode falls back to mock repos when no GitHub PAT is set
- Errors surface in the UI — never swallowed silently
- Model selection is automatic — the Orchestrator routes to the right specialist
- Active repo is hard-locked — the Orchestrator's context only contains the selected repo
- Active branch is the single context for commits, pushes, diffs, and chat — switching branches tears down the sandbox
- Chats are permanently branch-scoped — never duplicated or rebound across branches
- All merges go through GitHub PR API — no local `git merge`
- Auditor defaults to UNSAFE on any error (fail-safe design)
