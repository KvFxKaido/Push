# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

Mobile-native AI coding agent for developers who ship from anywhere.

No platform lock-in. Open source. Start on free tiers.
Self-hosted only. No managed service.

Push is a personal AI coding notebook backed by role-based AI agents that read your code, write patches, run checks in a sandbox, and commit/push changes from your phone or terminal.

Try it free with provider free tiers: OpenCode Zen or Ollama Cloud.
Bring your own provider: Ollama Cloud, OpenRouter, OpenCode Zen, or Nvidia NIM. Advanced Settings also expose opt-in private connectors for Azure OpenAI, AWS Bedrock, and Google Vertex.
Set provider/model defaults in Settings, then choose active chat and review models separately. Delegated Coder runs inherit the current chat's locked provider/model, and Auditor now follows that same chat lock when one exists.

## What It Does

Push is an execution control plane for developers who need to keep shipping when away from their desk.

- Review fast with structured cards for PRs, diffs, checks, and repo state
- Run on-demand Reviewer feedback on branch diffs, last commits, or local working trees, then send findings to chat or post PR-backed reviews to GitHub
- Delegate implementation from Orchestrator to Coder in a live sandbox
- Gate risky changes with Auditor SAFE/UNSAFE pre-commit verdicts
- Keep context repo-locked to one repo and one active branch
- Resume interrupted mobile runs with checkpoint + reconciliation
- Branch, commit, push, and merge through GitHub PR flow
- Start in a scratch workspace without GitHub auth and export anytime
- Use the same role-based agent system from terminal with Push CLI

## Why Push Is Different

- Runtime-selectable AI backends, no single-vendor lock-in
- Zero-barrier entry with free-tier-capable providers
- Full role-separated architecture: Orchestrator, Coder, Reviewer, Auditor
- Branch-scoped chat memory tied to the branch where each chat starts

## Who It's For

- Solo builders shipping while away from desktop
- Teams already paying for model providers and needing execution leverage
- Developers wanting a full AI coding workflow without buying another subscription

Push is optimized for momentum, decisions, and execution control from mobile, not for replacing deep desktop IDE sessions.

The app is free. AI usage depends on the provider and plan you choose.

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Built-in providers: Ollama Cloud, OpenRouter, OpenCode Zen, Nvidia NIM; opt-in private connectors: Azure OpenAI, AWS Bedrock, Google Vertex |
| Sandbox | Modal (serverless containers) |
| Auth | GitHub App or Personal Access Token |
| APIs | GitHub REST API |
| Deploy | Cloudflare Workers + Assets |
| PWA | Service Worker, Web App Manifest |

## Reliability & Harness

Push prioritizes harness reliability over raw model capability. Core shipped capabilities include:

**Context Control**
- **Range-aware file reads** — `sandbox_read_file` supports `start_line`/`end_line` with line-numbered output for precise context
- **Symbol extraction** — `sandbox_read_symbols` extracts function/class/type indexes without reading full files
- **Multi-tool per turn** — parallel read-only tool calls in a single round, with optional trailing mutation
- **Meta envelope** — every tool result includes `[meta]` with round number, context size, and sandbox dirty state
- **Agent working memory** — Coder maintains compaction-safe internal state (plan, files touched, errors) via `[CODER_STATE]` blocks

**Edit Safety**
- **Hashline edits** — `sandbox_edit_file` uses content hashes (default 7-char, up to 12-char for disambiguation) as line references, eliminating line-number drift
- **Edit convenience wrappers** — `sandbox_edit_range` (line-range replacement) and `sandbox_search_replace` (unique-line substring replacement) compile/delegate to hashline edits with the same safety checks
- **Multi-file patchsets** — `sandbox_apply_patchset` validates all edits before writing any files

**Execution Safety**
- **Pre-commit audit gate** — Auditor agent enforces SAFE/UNSAFE verdict before standard commits (`sandbox_prepare_commit` path); draft checkpoints via `sandbox_save_draft` are explicitly unaudited
- **Acceptance criteria** — `delegate_coder` supports shell commands that verify task success post-completion
- **Error taxonomy** — structured error types (`FILE_NOT_FOUND`, `EXEC_TIMEOUT`, `STALE_FILE`, etc.) with `retryable` flag so the agent makes intelligent retry decisions
- **Execution provenance** — tool-result metadata tracks every sandbox operation for traceability
- **Garbled tool-call recovery** — three-phase diagnosis, JSON repair, and truncation detection so models self-correct in one retry

**Session Reliability**
- **Resumable sessions** — interrupted runs checkpoint to localStorage and resume with sandbox reconciliation (`[SESSION_RESUMED]`) plus multi-tab lock safety

Harness reliability remains a core product priority. `documents/plans/Harness Reliability Plan.md` is kept as planning/reference history, not an active README checklist.

## Getting Started

```bash
cd app
npm install
npm run dev
```

For local auth/sandbox routes (`/api/*`), run the Worker in a second terminal:

```bash
npx wrangler dev --port 8787
```

`vite.config.ts` proxies `/api` to `http://127.0.0.1:8787` by default. Override with `VITE_API_PROXY_TARGET` if needed.

Create `app/.env` for local development, or paste keys in the Settings UI at runtime:

```env
VITE_OLLAMA_API_KEY=...               # Ollama Cloud
VITE_OPENROUTER_API_KEY=...           # OpenRouter (BYOK-compatible; configure provider keys in OpenRouter if desired)
VITE_ZEN_API_KEY=...                  # OpenCode Zen (OpenAI-compatible endpoint)
VITE_NVIDIA_API_KEY=...               # Nvidia NIM (OpenAI-compatible endpoint)
VITE_VERTEX_SERVICE_ACCOUNT_JSON=...  # Optional — Google Vertex service account JSON
VITE_VERTEX_REGION=global             # Optional — Google Vertex region
VITE_VERTEX_MODEL=google/gemini-2.5-pro # Optional — Google Vertex default model
VITE_TAVILY_API_KEY=...               # Optional — Tavily web search (premium LLM-optimized results)
VITE_GITHUB_TOKEN=...                 # Optional — PAT for GitHub API access
VITE_GITHUB_CLIENT_ID=...             # Optional — GitHub App OAuth client ID
VITE_GITHUB_APP_REDIRECT_URI=...      # Optional — GitHub App OAuth redirect URI
VITE_GITHUB_OAUTH_PROXY=...           # Optional — GitHub OAuth token exchange proxy
VITE_GITHUB_REDIRECT_URI=...          # Optional — GitHub OAuth redirect URI
```

Provider keys can also be pasted into Settings at runtime. Azure OpenAI and Bedrock now use one shared API key and one shared base URL per provider, with up to three saved deployment/model entries on top. Vertex now uses a Google service account JSON plus region and model in the normal path, with the old raw Vertex OpenAPI endpoint flow kept as a legacy fallback. When 2+ provider keys are set, a backend picker appears in Settings. Settings owns the default backend/model picks plus the app's active backend preference, the chat composer owns the current chat selection, delegated Coder runs inherit that chat lock, Reviewer keeps its own sticky provider/model selection, and Auditor uses the current chat lock when available, otherwise the active backend. Web default mode is **Auto** (Zen-first when available). In local development, with no AI keys configured, the app falls back to the demo-provider path. GitHub-backed repo and PR surfaces require GitHub auth; without it, the unauthenticated path is onboarding or a scratch workspace.

## Push CLI

Push also ships with a local terminal agent that uses the same role-based architecture on your filesystem. Current terminal work is going into the full-screen TUI, while the classic REPL and headless `push run` flow remain supported.

```bash
# from repo root
./push config init
PUSH_TUI_ENABLED=1 ./push
./push run --task "Implement X and run tests"
```

- **TUI** is the current terminal focus. Enable it with `PUSH_TUI_ENABLED=1`; then bare `./push` opens the full-screen interface.
- **Interactive fallback** (`./push` with TUI disabled) keeps the classic REPL with live streaming and in-session `/model` + `/provider` switching.
- **Headless mode** (`./push run --task "..."`) runs one task and exits, with optional `--accept` checks.

Full CLI docs and command reference: `cli/README.md`.

## GitHub Authentication

Push supports two authentication methods:

### Option 1: GitHub App (Recommended)

Install the Push GitHub App and authorize access to your repos. Tokens refresh automatically — no manual management needed. You control exactly which repos the agent can access.

### Option 2: Personal Access Token

Create a PAT with `repo` scope and paste it in the Settings UI. Simpler setup, but tokens can expire and need manual rotation.

## Scratch Workspace

Don't have GitHub access right now? Start a **scratch workspace** — an ephemeral workspace with no authentication required. The agent can still write code, run commands, and iterate in an isolated Linux container.

- **30 minute lifetime** — Container auto-terminates (5-minute warning banner shown)
- **Download anytime** — Export your work as a tar.gz archive before expiry
- **No GitHub needed** — Start from onboarding or the repo dropdown
- **Same agent power** — Full Coder capabilities: file ops, execution, web search

Use it for quick experiments, learning the interface, or when you're on a device without GitHub credentials.

## Deploying Your Instance

For a self-hosted deployment, run the app on Cloudflare Workers. The worker at `app/worker.ts` proxies the built-in chat routes (`/api/ollama/chat`, `/api/openrouter/chat`, `/api/zen/chat`, `/api/nvidia/chat`), the opt-in private-connector routes (`/api/azure/chat`, `/api/bedrock/chat`, `/api/vertex/chat`), and `/api/sandbox/*` to Modal web endpoints. Built-in provider keys live as runtime secrets; the Vertex route can also mint Google access tokens server-side from the saved service-account JSON and route Gemini through Vertex OpenAPI while translating Claude partner-model responses back into the app's OpenAI-style SSE stream. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.


```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Architecture

Role-based agent system. **Models are replaceable; roles are not.**

- **Orchestrator** — conversational lead, tool orchestration, delegates to Coder
- **Coder** — autonomous code implementation in sandbox (up to 30 rounds, 60s inactivity timeout per round, ~120k-char context cap)
- **Reviewer** — on-demand advisory diff review in the Workspace Hub; can review branch diffs, last commits, or local working-tree changes
- **Auditor** — pre-commit safety gate, binary SAFE/UNSAFE verdict

The web app ships with four built-in AI backends: **Ollama Cloud**, **OpenRouter**, **OpenCode Zen**, and **Nvidia NIM**. It also exposes opt-in private connectors for **Azure OpenAI**, **AWS Bedrock**, and **Google Vertex** in advanced Settings. The built-ins, Azure, and Bedrock use OpenAI-compatible streaming. Vertex now uses a Google service account JSON plus region and model in the normal path: Gemini calls go through Vertex's OpenAPI surface, Claude calls go through Vertex's Anthropic partner-model API, and the Worker translates the response back into the app's OpenAI-style SSE stream. Legacy raw Vertex OpenAPI endpoint config still works as a fallback. Backend/model routing is currently split: Settings stores default backend/model picks and the app's active backend preference, the chat composer owns a per-chat selection that locks the Orchestrator after the first user message, delegated Coder runs inherit that chat-locked provider/model, Reviewer keeps its own sticky provider/model selection, and Auditor follows the same chat-locked provider/model when one exists. For new web chats, Auto backend selection prefers OpenCode Zen when available; Azure and Bedrock each use one shared API key and one shared base URL per provider, with up to three saved deployment/model entries, while Vertex appears once its service-account config is valid.

**OpenRouter** provides access to 50+ models through a single pay-per-use API. Push ships with a curated catalog spanning Claude, GPT-4.1/GPT-4o/GPT-5.4, Codex, Cohere Command-R, Gemini, Mistral, MiniMax, Qwen, GLM, DeepSeek, Perplexity Sonar, Arcee Trinity, Mercury, Xiaomi MiMo, Grok 4.20, and Kimi.

There is always exactly one **Active Branch** per repo session — it is the commit target, push target, diff base, and chat context. Switching branches tears down the sandbox and creates a fresh one (clean state). Workspace actions for files, diff, review, console, scratchpad, and commit/push are unified in the **Workspace Hub**, a coding notebook for the active branch. Reviewer has three sources: **Branch diff** reviews the pushed branch against the default branch or the open PR diff without starting a sandbox, **Last commit** reviews the most recent pushed commit on the active branch, and **Working tree** reviews uncommitted sandbox edits. Findings can jump into Diff or be sent into chat as fix requests. Only PR-backed Branch diff reviews can be posted back as a GitHub PR review. All merges go through **GitHub Pull Requests** — Push never runs `git merge` locally. The merge flow: check working tree → find/create PR → Auditor review → check eligibility → merge via GitHub API (merge commit strategy). Chats are permanently **branch-scoped** and grouped by branch in the history drawer.

If a run is interrupted (phone lock/background), Push checkpoints state and surfaces a **ResumeBanner** on return. Resume validates sandbox/branch/repo identity, fetches sandbox status (HEAD/dirty/diff), injects a reconciliation message, and continues the tool loop.

## Project Structure

```
Push/
├── push                   # CLI launcher script
├── AGENTS.md              # Agent-facing project context
├── CLAUDE.md              # AI assistant context (architecture, conventions)
├── GEMINI.md              # Gemini-facing project context
├── wrangler.jsonc         # Cloudflare Workers config
├── cli/
│   ├── cli.mjs            # CLI entrypoint (interactive + headless)
│   ├── engine.mjs         # Assistant loop and tool orchestration
│   ├── tools.mjs          # Local file/exec/git tools
│   ├── provider.mjs       # Provider config + streaming client
│   └── README.md          # CLI usage and full reference
├── sandbox/
│   ├── app.py             # Modal Python App — sandbox web endpoints
│   └── requirements.txt
├── app/
│   ├── worker.ts          # Cloudflare Worker — provider proxies, native Vertex adapter, and sandbox proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/           # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet
│   │   │   ├── cards/          # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, and more
│   │   │   ├── filebrowser/    # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/             # shadcn/ui component library
│   │   ├── hooks/              # useChat, useSandbox, useScratchpad, useUserProfile, useGitHubAuth, useGitHubAppAuth, useRepos, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useModelCatalog, useVertexConfig, useSnapshotManager, useBranchManager, useProjectInstructions, useTavilyConfig, useUsageTracking
│   │   ├── lib/                # Agent logic, tool protocols, git operations, web search, model catalog, Vertex provider helpers, prompts
│   │   ├── sections/           # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen, ChatScreen
│   │   └── types/              # TypeScript definitions
│   └── package.json
└── README.md
```

## Credits

[models.dev](https://models.dev/) ([GitHub](https://github.com/anomalyco/models.dev)) powers Push's model icons and helps enrich the OpenRouter model catalog with cross-model metadata such as modalities, tool-calling support, reasoning flags, and context limits. Their open model database and API made it much easier to keep the catalog useful without hand-curating every field ourselves.

## License

MIT — see [LICENSE](LICENSE) for details.
