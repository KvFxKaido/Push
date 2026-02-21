# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

**Built for reviewing, deciding, and shipping — not typing thousands of lines on glass.**

Push is a mobile-native AI coding agent with direct GitHub repo access. It is built as an **execution control plane** for builders who already have an AI stack and want to keep shipping when away from their desk.

## What It Does

Push is a personal chat interface backed by role-based AI agents. Select a repo, ask questions, and orchestrate real code work from your phone.

- **Review and decide fast** — PRs, diffs, checks, and repo state in structured cards
- **Delegate implementation** — Orchestrator can hand coding work to Coder in a live sandbox
- **Gate risky changes** — Auditor enforces a SAFE/UNSAFE pre-commit verdict
- **Stay repo-locked** — active chat context is bound to one repo and one active branch
- **Use your existing AI stack** — pick Mistral, Ollama Cloud, OpenRouter, Z.AI, Google, or OpenCode Zen
- **Resume interrupted runs** — checkpoint + reconciliation flow when mobile sessions are interrupted
- **Merge from mobile** — branch, commit, push, and merge through GitHub PR flow
- **Fallback to sandbox-only mode** — start without GitHub auth and export your workspace anytime

## Why Push Is Different

- **Role-separated agents** — Orchestrator, Coder, and Auditor have distinct responsibilities
- **Branch-scoped memory** — chats are permanently tied to the branch where they were created
- **Provider-agnostic backend** — backend choice is runtime-selectable and locked per chat for consistency

## Who It's For

Push is for builders in motion:

- **Solo founders** who need to review and ship while away from desktop
- **Indie hackers** who already pay for AI providers and want better execution leverage
- **Lead developers / CTOs** who want mobile oversight and approvals without losing technical depth
- **Developers who want control** — open-source codebase with self-hosting path and provider choice

Push is not trying to replace desktop IDE flow for deep coding sessions. It is optimized for momentum, decisions, and execution control from mobile.

The app is free. AI usage depends on your provider subscription, and you choose which provider to run.

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Mistral Vibe, Ollama Cloud, OpenRouter, Z.AI, Google, or OpenCode Zen — flexible provider choice |
| Sandbox | Modal (serverless containers) |
| Auth | GitHub App or Personal Access Token |
| APIs | GitHub REST API |
| Deploy | Cloudflare Workers + Assets |
| PWA | Service Worker, Web App Manifest |

## Reliability & Harness

Push prioritizes harness reliability over raw model capability. Current shipped features:

- **Range-aware file reads** — `sandbox_read_file` supports `start_line`/`end_line` with line-numbered output for precise context
- **Hashline edits** — `sandbox_edit_file` uses 7-char content hashes as line references, eliminating line-number drift
- **Garbled tool-call recovery** — three-phase diagnosis, JSON repair, and truncation detection so models self-correct in one retry
- **Pre-commit audit gate** — Auditor agent enforces SAFE/UNSAFE verdict before any commit lands
- **Execution provenance** — tool-result metadata tracks every sandbox operation for traceability
- **Error taxonomy** — structured error types (`FILE_NOT_FOUND`, `EXEC_TIMEOUT`, `STALE_FILE`, etc.) with `retryable` flag so the agent makes intelligent retry decisions
- **Multi-tool per turn** — parallel read-only tool calls in a single round, with optional trailing mutation
- **Meta envelope** — every tool result includes `[meta]` with round number, context size, and sandbox dirty state
- **Acceptance criteria** — `delegate_coder` supports shell commands that verify task success post-completion
- **Agent working memory** — Coder maintains compaction-safe internal state (plan, files touched, errors) via `[CODER_STATE]` blocks
- **Resumable sessions** — interrupted runs checkpoint to localStorage and resume with sandbox reconciliation (`[SESSION_RESUMED]`) plus multi-tab lock safety
- **Symbol extraction** — `sandbox_read_symbols` extracts function/class/type indexes without reading full files
- **Multi-file patchsets** — `sandbox_apply_patchset` validates all edits before writing any files

Next up: visibility polish, telemetry, and provider-compliance diagnostics. See `documents/plans/Harness Reliability Plan.md` for the full plan.

## Getting Started

```bash
cd app
npm install
npm run dev
```

For local auth/sandbox routes (`/api/*`), run the Worker in a second terminal:

```bash
cd /home/ishaw/projects/Push
npx wrangler dev --port 8787
```

`vite.config.ts` proxies `/api` to `http://127.0.0.1:8787` by default. Override with `VITE_API_PROXY_TARGET` if needed.

Create `app/.env` for local development, or paste keys in the Settings UI at runtime:

```env
VITE_MISTRAL_API_KEY=...              # Mistral Vibe
VITE_OLLAMA_API_KEY=...               # Ollama Cloud
VITE_OPENROUTER_API_KEY=...           # OpenRouter (50+ models via pay-per-use)
VITE_ZAI_API_KEY=...                  # Z.AI (GLM)
VITE_GOOGLE_API_KEY=...               # Google Gemini (OpenAI-compatible endpoint)
VITE_ZEN_API_KEY=...                  # OpenCode Zen (OpenAI-compatible endpoint)
VITE_TAVILY_API_KEY=...               # Optional — Tavily web search (premium LLM-optimized results)
VITE_GITHUB_TOKEN=...                 # Optional — PAT for GitHub API access
VITE_GITHUB_CLIENT_ID=...             # Optional — GitHub App OAuth client ID
VITE_GITHUB_APP_REDIRECT_URI=...      # Optional — GitHub App OAuth redirect URI
VITE_GITHUB_OAUTH_PROXY=...           # Optional — GitHub OAuth token exchange proxy
VITE_GITHUB_REDIRECT_URI=...          # Optional — GitHub OAuth redirect URI
VITE_BROWSER_TOOL_ENABLED=true        # Optional — enables sandbox browser tools in prompts
```

### Provider Key Policy (All Providers)

- Use provider-native API keys for the selected backend and keep production keys server-side (Worker secrets), not in shipped client bundles.
- Review cadence: quarterly. Last reviewed **2026-02-21** (next target **2026-05-21**).
- Full per-provider policies and references:
  - Mistral: `documents/security/PROVIDER_USAGE_POLICY.md`
  - OpenRouter: `documents/security/PROVIDER_USAGE_POLICY_OPENROUTER.md`
  - Ollama: `documents/security/PROVIDER_USAGE_POLICY_OLLAMA.md`
  - Z.AI: `documents/security/PROVIDER_USAGE_POLICY_ZAI.md`
  - Google Gemini: `documents/security/PROVIDER_USAGE_POLICY_GOOGLE.md`
  - OpenCode Zen: `documents/security/PROVIDER_USAGE_POLICY_ZEN.md`

Without any AI key the app prompts for one on first use. When 2+ provider keys are set, a backend picker appears in Settings.

## Push CLI

Push also ships with a local terminal agent that uses the same role-based architecture on your filesystem.

```bash
# from repo root
./push config init
./push
./push run --task "Implement X and run tests"
```

- **Interactive mode** (`./push`) streams responses and supports in-session `/model` + `/provider` switching.
- **Headless mode** (`./push run --task "..."`) runs one task and exits, with optional `--accept` checks.

Full CLI docs and command reference: `cli/README.md`.

## GitHub Authentication

Push supports two authentication methods:

### Option 1: GitHub App (Recommended)

Install the Push GitHub App and authorize access to your repos. Tokens refresh automatically — no manual management needed. You control exactly which repos the agent can access.

### Option 2: Personal Access Token

Create a PAT with `repo` scope and paste it in the Settings UI. Simpler setup, but tokens can expire and need manual rotation.

## Sandbox Mode

Don't have GitHub access right now? Start a **Sandbox** — an ephemeral workspace with no authentication required. The agent can still write code, run commands, and iterate in an isolated Linux container.

- **30 minute lifetime** — Container auto-terminates (5-minute warning banner shown)
- **Download anytime** — Export your work as a tar.gz archive before expiry
- **No GitHub needed** — Start from onboarding or the repo dropdown
- **Same agent power** — Full Coder capabilities: file ops, execution, browser tools

Use it for quick experiments, learning the interface, or when you're on a device without GitHub credentials.

## Production

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/ollama/chat`, `/api/mistral/chat`, `/api/openrouter/chat`, `/api/zai/chat`, `/api/google/chat`, and `/api/zen/chat`, plus `/api/sandbox/*` to Modal web endpoints, with API keys stored as runtime secrets. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.

For browser tools, set Worker secrets `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. The Worker injects them server-side for `/api/sandbox/browser-screenshot` and `/api/sandbox/browser-extract` so browser credentials never reach the client.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Architecture

Role-based agent system. **Models are replaceable; roles are not.**

- **Orchestrator** — conversational lead, tool orchestration, delegates to Coder
- **Coder** — autonomous code implementation in sandbox (runs until done, with 90s per-round timeout)
- **Auditor** — pre-commit safety gate, binary SAFE/UNSAFE verdict

Six AI backends are supported: **Mistral Vibe**, **Ollama Cloud**, **OpenRouter**, **Z.AI**, **Google Gemini**, and **OpenCode Zen**. All use OpenAI-compatible streaming. The active backend serves all three roles. Provider selection is locked per chat after the first user message; start a new chat to switch providers.

**OpenRouter** provides access to 50+ models (Claude, GPT-4, Codex, Gemini, etc.) through a single pay-per-use API. Push includes a curated list of 12 models covering all major providers.

There is always exactly one **Active Branch** per repo session — it is the commit target, push target, diff base, and chat context. Switching branches tears down the sandbox and creates a fresh one (clean state). Workspace actions for files, diff, console, scratchpad, and commit/push are unified in the **Workspace Hub**. All merges go through **GitHub Pull Requests** — Push never runs `git merge` locally. The merge flow: check working tree → find/create PR → Auditor review → check eligibility → merge via GitHub API (merge commit strategy). Chats are permanently **branch-scoped** and grouped by branch in the history drawer.

If a run is interrupted (phone lock/background), Push checkpoints state and surfaces a **ResumeBanner** on return. Resume validates sandbox/branch/repo identity, fetches sandbox status (HEAD/dirty/diff), injects a reconciliation message, and continues the tool loop.

## Harness Focus

Current harness priorities from `documents/plans/Harness Reliability Plan.md`:

- [x] stale-write protection + write-path telemetry baseline
- [x] improved operator visibility (Coder status events in console, cleaner dialogue/tool display)
- [x] read-path efficiency (`sandbox_read_file` range args, line-numbered output, truncation-aware edit safety)
- [x] garbled tool-call recovery (three-phase diagnosis, JSON repair, truncation detection, specific error feedback)
- [x] hashline edit protocol (`sandbox_edit_file` with content-addressed line hashes)
- [x] Agent Experience Wishlist — shipped (error taxonomy, multi-tool dispatch, meta envelope, acceptance criteria, working memory, structured malformed-call feedback, edit result diffs, `sandbox_read_symbols`, `sandbox_apply_patchset`)

## Project Structure

```
Push/
├── push                   # CLI launcher script
├── CLAUDE.md              # AI assistant context (architecture, conventions)
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
│   ├── worker.ts          # Cloudflare Worker — provider proxies (Ollama/Mistral/OpenRouter/Z.AI/Google/Zen) + sandbox proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/           # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspaceHubSheet, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner, BranchCreateSheet, MergeFlowSheet
│   │   │   ├── cards/          # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, BrowserScreenshotCard, BrowserExtractCard, and more
│   │   │   ├── filebrowser/    # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/             # shadcn/ui component library
│   │   ├── hooks/              # useChat, useSandbox, useScratchpad, useUserProfile, useGitHubAuth, useGitHubAppAuth, useRepos, useFileBrowser, useCodeMirror, useCommitPush, useProtectMain, useTavilyConfig, useUsageTracking
│   │   ├── lib/                # Agent logic, tool protocols, git operations, web search, model catalog, prompts
│   │   ├── sections/           # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen
│   │   └── types/              # TypeScript definitions
│   └── package.json
└── README.md
```

## License

MIT — see [LICENSE](LICENSE) for details.
