# Push — Mobile AI Coding Agent

ChatGPT with direct access to your repos. A personal, mobile-first AI coding notebook backed by role-based AI agents that can read your code, write patches, run them in a sandbox, and commit/push changes.

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
  - Ollama Cloud (open models on cloud GPUs via ollama.com, OpenAI-compatible SSE)
  - OpenRouter (50+ models via openrouter.ai, OpenAI-compatible SSE)
  - OpenCode Zen (routing API via opencode.ai/zen, OpenAI-compatible SSE)
  - Nvidia NIM (OpenAI-compatible endpoint via integrate.api.nvidia.com)
- Modal (serverless containers) for sandbox code execution
- Cloudflare Workers (streaming proxy + sandbox proxy)

- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. Backend/model routing is currently hybrid: Settings stores defaults and the active backend preference, chat/review selection happens separately, and the role split stays fixed underneath.

- **Orchestrator** — Conversational lead, interprets user intent, coordinates specialists, assembles results. The voice of the app.
- **Coder** — Code implementation and execution engine. Writes, edits, and runs code in a sandbox (up to 30 rounds, 60s inactivity timeout per round, ~120k-char context cap).
- **Reviewer** — On-demand advisory diff review in the Workspace Hub. Can review branch diffs, last commits, or local working-tree changes, produces structured findings, can hand findings off to chat, and can post PR-backed reviews to GitHub.
- **Auditor** — Risk specialist, pre-commit gate, binary verdict. Required for standard commit flow (`sandbox_prepare_commit` path).

**AI backends:** The web app ships with four built-in providers — **Ollama Cloud** (`ollama.com`), **OpenRouter** (`openrouter.ai`), **OpenCode Zen** (`opencode.ai/zen`), and **Nvidia NIM** (`integrate.api.nvidia.com`) — plus opt-in private connectors for **Azure OpenAI**, **AWS Bedrock**, and **Google Vertex** in advanced Settings. The built-ins, Azure, and Bedrock use OpenAI-compatible SSE streaming. Azure and Bedrock use validated base URLs plus model/deployment values and can each save up to three deployment presets. Vertex now uses a Google service account JSON plus region and model in the normal path; the Worker mints Google access tokens server-side, routes Gemini through Vertex OpenAPI, routes Claude through Vertex's Anthropic partner-model API, and translates responses back into OpenAI-style SSE for the app. Legacy raw Vertex OpenAPI config still works as a fallback. Backend/model routing is currently split: the chat composer owns the current chat selection and the Orchestrator locks to that provider/model after the first user message, delegated Coder runs inherit that chat-locked provider/model, Reviewer keeps its own sticky provider/model selection, and Auditor now follows the same chat-locked provider/model when available. For new web chats, Auto backend mode prefers OpenCode Zen when available. Default Ollama model is `gemini-3-flash-preview`. Default OpenRouter model is `claude-sonnet-4.6:nitro`. Default Zen model is `big-pickle`. Default Nvidia model is `nvidia/llama-3.1-nemotron-70b-instruct`. OpenRouter provides access to 50+ models through a single API, and Push ships with a curated catalog spanning Claude, GPT-4.1/GPT-4o/GPT-5.4, Codex, Cohere Command-R, Gemini, Mistral, MiniMax, Qwen, GLM, DeepSeek, Perplexity Sonar, Arcee Trinity, Mercury, Xiaomi MiMo, Grok, and Kimi.

**Onboarding & state machine:** Users connect with GitHub App (recommended) or GitHub PAT, then select an active repo before chatting. Sandbox Mode lets users start an ephemeral workspace without any GitHub auth. The codebase still contains demo/mock fallbacks: GitHub repo and PR views fall back to mock data when no GitHub token is configured, and local development uses a demo-provider path when no AI keys are configured. Product-wise the flow is `onboarding → launcher/home → chat` (plus `file-browser` when sandbox files are open), even though the internal screen key is still `home`. The `isSandboxMode` flag bypasses auth and repo selection.

**Tool protocol:** Tools are prompt-engineered — the system prompt defines available tools and JSON format. The orchestrator detects JSON tool blocks in responses, executes them against GitHub's API, injects results as synthetic messages, and re-calls the LLM. The Orchestrator tool loop is unbounded; the Coder loop is bounded by safety limits (30 rounds, 60s inactivity timeout per round, ~120k-char context cap). Sandbox tools use the same JSON block pattern, detected by a unified tool dispatch layer. Multi-tool dispatch: `detectAllToolCalls()` scans for all tool calls per message, splits them into parallel read-only calls and an optional trailing mutation — reads execute via `Promise.all()`, then the mutation runs. Tool results include structured error fields (`error_type`, `retryable`) via `classifyError()`, and a `[meta]` envelope with round number, context size, and sandbox dirty state.

**Harness focus (current):** Reliability improvements are prioritized over model churn. Active tracks are defined in `documents/plans/Harness Reliability Plan.md` (edit reliability, read efficiency, tool-loop robustness, and operator visibility). Track B shipped: `sandbox_read_file` supports line ranges with numbered output and out-of-bounds warnings. `sandbox_edit_file` is active — edits are expressed as `HashlineOp[]` referencing content hashes (default 7-char, extendable to 12-char for disambiguation; see `lib/hashline.ts`), which eliminates line-number drift and provides implicit staleness detection. **Agent Experience Wishlist shipped** (see `documents/analysis/Agent Experience Wishlist.md`): 10 harness improvements — error taxonomy with retry semantics, structured malformed-call feedback, edit result diffs, multi-tool per turn, universal meta envelope, machine-checkable acceptance criteria, agent working memory, `sandbox_read_symbols`, and `sandbox_apply_patchset`. Server-side background jobs (Track D) are currently deferred; resumable sessions are the active interruption-recovery path.

**Web search tools:** The Orchestrator can search the web mid-conversation via `web-search-tools.ts`. Three backends: **Tavily** (premium, LLM-optimized results via `VITE_TAVILY_API_KEY`), **Ollama native search** (POST `/api/web_search`), and **DuckDuckGo** (free fallback). Web search is prompt-engineered — the system prompt defines a JSON tool format, and dispatch is client-side. API keys are configurable at runtime via Settings.

**Sandbox:** Modal (serverless containers) provides a persistent Linux environment per session. The repo is cloned into `/workspace` (or an empty workspace is created in Sandbox Mode). The Coder reads/writes files, runs commands, and gets diffs — all via sandbox tools. The Cloudflare Worker proxies sandbox requests to Modal web endpoints (keeps Modal auth server-side). Containers auto-terminate after 30 min.

**Sandbox Mode:** Ephemeral workspace with no GitHub repo. Entry via onboarding ("Try it now") or the launcher/home surface ("New Sandbox"). GitHub tools are blocked; only sandbox tools are available. Expiry warning at 5 min remaining. Download via header button, expiry banner, or `sandbox_download` AI tool (tar.gz archive). See `documents/archive/Sandbox mode.md` for full spec.

**Coder delegation:** The Orchestrator can delegate coding tasks to the Coder via `delegate_coder`. The Coder runs autonomously with its own tool loop in the sandbox (up to 30 rounds, 60s inactivity timeout per round, ~120k-char context cap), then returns a summary + cards to the Orchestrator. Delegation supports optional `acceptanceCriteria[]` — shell commands run after the Coder finishes to verify the task succeeded (pass/fail + output). The Coder maintains internal working memory (`CoderWorkingMemory`) via `coder_update_state` — plan, open tasks, files touched, assumptions, and errors are injected as a `[CODER_STATE]` block into every tool result, surviving context trimming.

**Reviewer:** The Reviewer runs on demand from the Workspace Hub `Review` tab. It has three sources: `Branch diff` reviews the pushed branch against the default branch or the open PR diff without starting a sandbox, `Last commit` reviews the diff of the most recent pushed commit on the active branch, and `Working tree` reviews uncommitted sandbox edits. Results use structured file-level comments with line anchors when the model can target specific added lines. Findings can jump into the Diff tab or be sent into chat as fix requests. Only PR-backed Branch diff reviews can be posted back to GitHub as a PR review (`event: COMMENT`) with inline comments for anchored findings and body bullets for file-level notes.

**Auditor gate:** Every standard commit goes through the Auditor via `sandbox_prepare_commit`. The Auditor reviews the diff and returns a binary verdict (SAFE/UNSAFE). UNSAFE blocks the commit. The Auditor defaults to UNSAFE on any error (fail-safe).

**Repo hard lock:** The Orchestrator only sees the active repo in its context. Other repos are stripped entirely. Repo switching is UI-driven (launcher/home repo cards + history drawer), never implicit from model output.

**User identity:** Users can set a display name, bio, and GitHub login in Settings (About You tab). Stored in localStorage via `useUserProfile` hook (standalone getter + React hook pattern). Injected into both Orchestrator and Coder system prompts via `buildUserIdentityBlock()` in orchestrator.ts. Bio content is escaped to prevent prompt injection via identity block boundaries.

**Scratchpad:** A shared notepad that both the user and the LLM can read/write. User accesses it in the Workspace Hub `Scratchpad` tab, and the LLM updates it via `set_scratchpad` / `append_scratchpad` tools. Content persists in localStorage and is always injected into the system prompt. Content is escaped to prevent prompt injection.

**Rolling window:** Context is managed by token budget, not fixed message count. The app summarizes older tool-heavy messages first, then trims oldest message pairs if still over budget, while keeping tool call/result pairs together.

**Resumable sessions:** When the user locks their phone or switches apps mid-tool-loop, the app checkpoints its state to localStorage (`run_checkpoint_${chatId}`). On return, a `ResumeBanner` offers to resume. Resume fetches `sandboxStatus()` (HEAD, dirty files, diff), injects a phase-specific reconciliation message (`[SESSION_RESUMED]`), and re-enters the normal tool loop. Coder delegation state is captured via `onWorkingMemoryUpdate` callback. Multi-tab coordination uses localStorage-based locks (not BroadcastChannel). Checkpoint size is capped at 50KB delta. See `documents/design/Resumable Sessions Design.md`.

**Active Branch model:** There is always exactly one Active Branch per repo session. It is the sandbox branch, chat context branch, commit target, push target, and diff base. Switching branches is atomic and explicit — it tears down the current sandbox and creates a fresh one on the target branch (clean state, no carryover). Branch switching is available in the history drawer, launcher/home, and the workspace branch selector. Branch creation is an explicit UI action available from the launcher/home surface and the Workspace Hub commit/push sheet; the assistant does not create branches itself. The Workspace Hub is the coding notebook for the active branch. On feature branches, the primary workspace action becomes "Merge into main". Non-default inactive branches can be deleted from the workspace branch selector.

**Merge flow (GitHub PR merge):** All merges go through GitHub — Push never runs `git merge` locally. "Merge into main" is a five-step ritual: (1) check for clean working tree (commit & push if dirty), (2) find or create a Pull Request via GitHub API, (3) Auditor reviews the PR diff (`main...active`) with a SAFE/UNSAFE verdict, (4) check merge eligibility (mergeable state, CI, reviews), (5) merge via GitHub API (merge commit strategy, no fast-forward). Post-merge: user can switch to main and optionally delete the branch. Merge conflicts and branch protection are surfaced, never bypassed. PRs are only created as part of this merge ritual — no standalone "create PR" action.

**Protect Main:** Optional setting that blocks direct commits to `main`, requiring a branch for all work. Configurable as a global default (on/off) plus per-repo override (inherit/always/never). Stored in localStorage via `useProtectMain` hook. No-op in Sandbox Mode.

**Branch-scoped chats:** Conversations are permanently bound to the branch on which they were created. The history drawer groups chats by branch. Switching to a branch with existing chats lets the user resume any of them. After merge, branch chats receive a closure message; deleted branches are marked `(Merged + Deleted)` in history. Chats are never duplicated or rebound.

**PR awareness:** The launcher/home surface shows repo activity, including open PR counts and recent activity markers. Chat tools include `github_list_prs`, `github_get_pr`, `github_pr_diff`, and `github_list_branches` for reading PR/branch state in any repo. The Workspace Hub `Review` tab can review the active branch or latest commit directly from GitHub without a sandbox, send findings into chat as fix requests, and, when a Branch diff review resolves to an open PR, post Reviewer findings back to GitHub.

**Project instructions (two-phase loading):** When the user selects a repo, the app immediately fetches `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` via the GitHub REST API in that order and injects the first match into the Orchestrator's system prompt and the Coder's context. When a sandbox becomes ready later, the app currently re-reads `/workspace/AGENTS.md` only, so local edits to the canonical project instructions file can upgrade the content. This still ensures all agents have project context from the first message, not just after sandbox spin-up.

## Project Layout

```
app/src/
  components/chat/        # Chat UI (ChatContainer, ChatInput, MessageBubble, AgentStatusBar, AttachmentPreview, ContextMeter, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet)
  components/cards/       # Rich inline cards (PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, SandboxDownloadCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, EditorPanel, FileCard, FileListCard, BranchListCard, CIStatusCard, CommitListCard, CommitFilesCard, PRListCard, TypeCheckCard, WorkflowRunsCard, WorkflowLogsCard, SandboxStateCard, CardRenderer)
  components/filebrowser/ # File browser UI (FileActionsSheet, CommitPushSheet, FileEditor, UploadButton)
  components/ui/          # shadcn/ui component library
  hooks/                  # React hooks (useChat, useGitHubAuth, useGitHubAppAuth, useGitHub, useRepos, useActiveRepo, useSandbox, useScratchpad, useUserProfile, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useOllamaConfig, useOpenRouterConfig, useZenConfig, useNvidiaConfig, useVertexConfig, useTavilyConfig, useModelCatalog, useSnapshotManager, useBranchManager, useProjectInstructions, useUsageTracking, use-mobile)
  lib/                    # Orchestrator, tool protocol, sandbox client, agent modules, workspace context, web search, model catalog, prompts, snapshot manager
  sections/               # Screen components (OnboardingScreen, RepoPicker, FileBrowser, HomeScreen, ChatScreen)
  types/                  # TypeScript type definitions
  App.tsx                 # Root component, screen state machine, wires extracted hooks
app/worker.ts        # Cloudflare Worker — provider proxies, native Vertex adapter, and sandbox proxy to Modal
cli/                 # Push CLI — local coding agent
  cli.mjs            # Entrypoint (arg parsing, interactive/headless modes, Ctrl+C abort)
  engine.mjs         # Assistant/tool loop, working memory dedup, context budget tracking
  tools.mjs          # Tool executor, guards, hashline edits, git tools, risk detection, file backup
  provider.mjs       # SSE streaming client, retry policy, abort signal merge
  workspace-context.mjs # Workspace snapshot + project instruction loading for system prompt
  session-store.mjs  # Session state/events persistence, protocol-aligned envelopes
  config-store.mjs   # ~/.push/config.json read/write/env overlay
  hashline.mjs       # Hashline edit protocol (anchored line refs, multi-line content)
  file-ledger.mjs    # File awareness ledger (per-file path/status tracking)
  tool-call-metrics.mjs # Malformed tool-call observability
  pushd.mjs          # Daemon skeleton (Unix socket, NDJSON IPC)
  AGENT-WISHLIST.md  # Agent experience wishlist (shipped — 10 items)
  tests/             # node:test suite
sandbox/app.py       # Modal Python App — sandbox web endpoints (file ops, exec/git, archive download)
sandbox/requirements.txt
scripts/             # One-off scripts (provider compliance, etc.)
push                 # Bash launcher (repo root)
wrangler.jsonc       # Cloudflare Workers config (repo root)
```

## Key Files

- `lib/orchestrator.ts` — System prompt, multi-backend streaming, provider routing (including native Vertex headers), think-token parsing, token-budget context management, `buildUserIdentityBlock()` (user identity injection)
- `lib/github-tools.ts` — GitHub tool protocol (prompt-engineered function calling via JSON blocks), `delegate_coder`, `fetchProjectInstructions` (reads AGENTS.md/CLAUDE.md/GEMINI.md from repos via API), branch/merge/PR operations (`executeCreateBranch`, `executeCreatePR`, `executeMergePR`, `executeDeleteBranch`, `executeCheckPRMergeable`, `executeFindExistingPR`, `findOpenPRForBranch`, `fetchGitHubReviewDiff`, `executePostPRReview`)
- `lib/sandbox-tools.ts` — Sandbox tool definitions, detection, execution, `SANDBOX_TOOL_PROTOCOL` prompt; includes `sandbox_edit_file` (hashline-based edits with diff output), `sandbox_edit_range`, `sandbox_search_replace`, `sandbox_read_symbols` (AST/regex symbol extraction), `sandbox_apply_patchset` (multi-file transactional edits), `classifyError()` (structured error taxonomy), `formatStructuredError()`
- `lib/hashline.ts` — Hashline edit protocol: `calculateLineHash()` (default 7-char content hash per line, extendable to 12-char for disambiguation), `applyHashlineEdits()`, `HashlineOp` type; underpins `sandbox_edit_file` and eliminates line-number drift
- `lib/diff-utils.ts` — Canonical shared diff parsing: `parseDiffStats()`, `parseDiffIntoFiles()`, `formatSize()`; used by sandbox-tools, auditor-agent, coder-agent, FileListCard, SandboxDownloadCard, FileBrowser, file-utils, file-processing
- `lib/sandbox-client.ts` — HTTP client for `/api/sandbox/*` endpoints (thin fetch wrappers), `mapSandboxErrorCode()` (maps Modal error codes to `ToolErrorType`), `sandboxStatus()` (lightweight git status + HEAD + diff for session recovery)
- `lib/scratchpad-tools.ts` — Scratchpad tool definitions (`set_scratchpad`, `append_scratchpad`), prompt injection escaping
- `lib/tool-dispatch.ts` — Unified tool dispatch (GitHub + Sandbox + Scratchpad + delegation), `detectAllToolCalls()` (multi-tool detection with read/mutate split), `isReadOnlyToolCall()`, `DetectedToolCalls` type
- `lib/coder-agent.ts` — Coder sub-agent loop (up to 30 rounds, 60s inactivity timeout per round, delegated runs inherit the chat-locked provider/model), `CoderWorkingMemory` + `coder_update_state` tool (compaction-safe internal state), `acceptanceCriteria` post-task verification, parallel read-only tool support, `onWorkingMemoryUpdate` callback for resumable session checkpoint capture
- `lib/reviewer-agent.ts` — Reviewer advisory diff review, added-line annotation for line anchors, structured `ReviewResult` parsing
- `lib/auditor-agent.ts` — Auditor review + verdict (fail-safe to UNSAFE, uses active backend)
- `lib/workspace-context.ts` — Builds active repo context for system prompt injection
- `lib/providers.ts` — AI provider configs (built-ins + advanced connectors), role-to-model mapping, backend preference
- `lib/vertex-provider.ts` — Google Vertex model catalog, service-account validation, region normalization, and native endpoint helpers
- `lib/web-search-tools.ts` — Web search tool definitions (Tavily, Ollama native search, DuckDuckGo fallback; prompt-engineered JSON format, client-side dispatch)
- `lib/model-catalog.ts` — Manages provider model lists and selection
- `lib/prompts.ts` — Prompt building utilities
- `lib/snapshot-manager.ts` — Workspace snapshot management and recovery
- `lib/file-processing.ts` — File content processing and transformation
- `lib/file-utils.ts` — File utility helpers
- `lib/sandbox-start-mode.ts` — Sandbox startup mode configuration
- `lib/codemirror-langs.ts` — CodeMirror language support configuration
- `lib/codemirror-theme.ts` — CodeMirror editor theme
- `lib/safe-storage.ts` — Safe localStorage/sessionStorage wrappers (null-safe, SSR-safe)
- `lib/edit-metrics.ts` — In-memory observability for `sandbox_write_file` operations (latency, stale/error counts per session)
- `lib/file-awareness-ledger.ts` — File Awareness Ledger: tracks what lines the model has read per file (`never_read` / `partial_read` / `fully_read` / `model_authored` / `stale`); part of Truncation-Aware Edit Safety (Track B)
- `lib/tool-call-metrics.ts` — In-memory observability for malformed tool-call attempts by provider/model/reason
- `lib/utils.ts` — General utility functions
- `hooks/useChat.ts` — Chat state, message history, unified tool execution loop (multi-tool dispatch, `[meta]` envelope injection, structured malformed-call feedback), Coder delegation (with `acceptanceCriteria` passthrough), scratchpad integration, resumable sessions (`detectInterruptedRun()`, `resumeInterruptedRun`, `dismissResume`, checkpoint persistence, multi-tab lock, resume telemetry via `getResumeEvents()`)
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
- `hooks/useOpenRouterConfig.ts` — OpenRouter backend configuration and model selection
- `hooks/useZenConfig.ts` — OpenCode Zen backend configuration and model selection
- `hooks/useNvidiaConfig.ts` — Nvidia NIM backend configuration and model selection
- `hooks/useVertexConfig.ts` — Google Vertex configuration (service account JSON, region, model, native/legacy mode)
- `hooks/useTavilyConfig.ts` — Tavily web search API key management
- `hooks/useApiKeyConfig.ts` — Factory for provider API key hooks (shared skeleton: localStorage getter + env var fallback + React hook)
- `hooks/useExpandable.ts` — Generic expandable/collapsible UI state hook
- `hooks/useUsageTracking.ts` — Usage analytics tracking
- `hooks/useModelCatalog.ts` — Provider catalog and advanced connector state (model lists, refresh, auto-fetch on key availability, key input state for Settings UI, active backend)
- `hooks/useSnapshotManager.ts` — Workspace snapshot auto-save/restore, idle detection, 4-hour hard cap, heartbeat tracking
- `hooks/useBranchManager.ts` — Branch loading, display (with current branch injection), delete with confirmation, menu state
- `hooks/useProjectInstructions.ts` — Two-phase AGENTS.md loading (GitHub API → sandbox filesystem upgrade), workspace context building, template/AI creation
- `hooks/use-mobile.ts` — Mobile viewport detection
- `sections/ChatScreen.tsx` — Full chat screen UI (header, branch selector, sandbox controls, settings sheet, workspace hub, chat input)
- `types/index.ts` — All shared TypeScript types (includes card data types for sandbox, diff preview, audit verdict; agent experience types: `ToolErrorType`, `StructuredToolError`, `ToolResultMeta`, `AcceptanceCriterion`, `CriterionResult`, `CoderWorkingMemory`)

## Environment

Environment variables are defined in `app/.env` (local dev) and Cloudflare Worker secrets (production). API keys can also be set via the Settings UI at runtime. When no GitHub token is configured, repo and PR views fall back to mock/demo data. In local development, with no AI keys configured, the app uses the demo-provider path. Live AI runs require a configured provider key.

Key variables: `VITE_OLLAMA_API_KEY` (Ollama Cloud), `VITE_OPENROUTER_API_KEY` (OpenRouter), `VITE_ZEN_API_KEY` (OpenCode Zen), `VITE_NVIDIA_API_KEY` (Nvidia NIM), `VITE_VERTEX_SERVICE_ACCOUNT_JSON` / `VITE_VERTEX_REGION` / `VITE_VERTEX_MODEL` (Google Vertex native config), `VITE_TAVILY_API_KEY` (web search), `VITE_GITHUB_TOKEN` (PAT), `VITE_GITHUB_CLIENT_ID` / `VITE_GITHUB_APP_REDIRECT_URI` / `VITE_GITHUB_OAUTH_PROXY` / `VITE_GITHUB_REDIRECT_URI` (GitHub App OAuth).

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
- When no GitHub token is configured, repo and PR views fall back to mock/demo data
- Errors surface in the UI — never swallowed silently
- Role routing is automatic inside the agent system, but users can still choose provider/model defaults in Settings plus separate chat/review selections
- Active repo is hard-locked — the Orchestrator's context only contains the selected repo
- Active branch is the single context for commits, pushes, diffs, and chat — switching branches tears down the sandbox
- Chats are permanently branch-scoped — never duplicated or rebound across branches
- All merges go through GitHub PR API — no local `git merge`
- Auditor defaults to UNSAFE on any error (fail-safe design)
