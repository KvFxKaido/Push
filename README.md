# Push

[![Deploy Modal](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/deploy-modal.yml)
[![CI](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml/badge.svg)](https://github.com/KvFxKaido/Push/actions/workflows/ci.yml)

**Built for reviewing, deciding, and shipping — not typing thousands of lines on glass.**

Push is a mobile-native AI coding agent with direct GitHub repo access. Chat with your codebase, review PRs, and orchestrate changes from anywhere. It is designed for **momentum and decision-making on the go**, giving you a manager's interface to your code when you're away from your desk.

## What It Does

Push is a personal chat interface backed by role-based AI agents. Select a repo, ask questions, and the agent reads your code, analyzes PRs, runs sandbox operations, and shows results as inline cards — all in a streaming conversation.

- **Chat-first** — conversation is the primary interface, not forms or dashboards
- **Repo-locked context** — select a repo and the agent only sees that repo
- **Tool protocol** — the agent calls GitHub and sandbox tools mid-conversation (PRs, commits, diffs, tests, type checks, workflows)
- **Web search** — the agent can search the web mid-conversation via Tavily, Ollama native search, or DuckDuckGo fallback
- **Browser tools (optional)** — capture screenshots and extract page text via Browserbase in the sandbox
- **Scratchpad** — shared notepad for accumulating ideas, requirements, and decisions throughout a session
- **User identity** — tell the agent your name, bio, and GitHub login so it knows who it's working with
- **Streaming** — responses arrive token-by-token with visible thinking
- **Sandbox Mode** — Start coding immediately without GitHub auth. Ephemeral workspace that auto-expires after 30 minutes. Download your work before it disappears.

## Who It's For

Push is for developers who:

- **Hate burning API credits** — Use services with predictable monthly costs, not per-token surprises
- **Already subscribe to AI services** — Use your existing Kimi, Mistral, or Ollama Cloud subscription
- **Want mobile-native workflows** — Designed for momentum and decision-making on the go, not replacing your IDE
- **Like owning their tools** — Open source and architecturally self-hostable. While it uses Cloudflare and Modal by default, the codebase is designed for full control and can be self-hosted for maximum privacy.

The app is free. The AI requires a subscription — but you pick which one, and you know exactly what it costs.

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Kimi For Coding, Mistral Vibe, or Ollama Cloud — subscription-based, unlimited API |
| Sandbox | Modal (serverless containers) |
| Auth | GitHub App or Personal Access Token |
| APIs | GitHub REST API |
| Deploy | Cloudflare Workers + Assets |
| PWA | Service Worker, Web App Manifest |

## Getting Started

```bash
cd app
npm install
npm run dev
```

Create `app/.env` for local development, or paste keys in the Settings UI at runtime. Push works with AI services that include API access in their subscriptions:

```env
VITE_MOONSHOT_API_KEY=...              # Kimi For Coding (unlimited API with subscription)
VITE_MISTRAL_API_KEY=...              # Mistral Vibe (unlimited API with subscription)
VITE_OLLAMA_API_KEY=...               # Ollama Cloud (unlimited API with subscription)
VITE_TAVILY_API_KEY=...               # Optional — Tavily web search (premium LLM-optimized results)
VITE_GITHUB_TOKEN=...                 # Optional — PAT for GitHub API access
VITE_GITHUB_CLIENT_ID=...             # Optional — GitHub App OAuth client ID
VITE_GITHUB_APP_REDIRECT_URI=...      # Optional — GitHub App OAuth redirect URI
VITE_GITHUB_OAUTH_PROXY=...           # Optional — GitHub OAuth token exchange proxy
VITE_GITHUB_REDIRECT_URI=...          # Optional — GitHub OAuth redirect URI
VITE_BROWSER_TOOL_ENABLED=true        # Optional — enables sandbox browser tools in prompts
```

Without any AI key the app prompts for one on first use. When 2+ provider keys are set, a backend picker appears in Settings.

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

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/kimi/chat` to Kimi For Coding, `/api/ollama/chat` to Ollama Cloud, `/api/mistral/chat` to Mistral Vibe, and `/api/sandbox/*` to Modal web endpoints, with API keys stored as runtime secrets. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.

For browser tools, set Worker secrets `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. The Worker injects these server-side for `/api/sandbox/browser-screenshot` and `/api/sandbox/browser-extract` so browser credentials never reach the client.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Architecture

Role-based agent system. **Models are replaceable; roles are not.**

- **Orchestrator** — conversational lead, tool orchestration, delegates to Coder
- **Coder** — autonomous code implementation in sandbox (runs until done, with 90s per-round timeout)
- **Auditor** — pre-commit safety gate, binary SAFE/UNSAFE verdict

Three AI backends are supported: **Kimi For Coding**, **Mistral Vibe**, and **Ollama Cloud**. All use OpenAI-compatible streaming. The active backend serves all three roles. Provider selection is locked per chat after the first user message; start a new chat to switch providers.

## Browserbase Status

Current state from `documents/Browserbase Integration Spike.md`:

- [x] v1 complete and validated on deployed Worker + Modal
- [x] `sandbox_browser_screenshot` shipped (card UI + metadata)
- [x] `sandbox_browser_extract` shipped (card UI + bounded text extraction)
- [x] Browserbase credentials injected server-side via Worker secrets
- [x] Guardrails shipped (URL allowlist, private-network block, output caps)
- [x] Test suite shipped (97 tests across tool/client/routes/types)
- [ ] Validate on real mobile cellular networks (iOS Safari + Android Chrome)
- [ ] Progressively enable `VITE_BROWSER_TOOL_ENABLED` after latency/error checks

## Project Structure

```
Push/
├── CLAUDE.md              # AI assistant context (architecture, conventions)
├── wrangler.jsonc         # Cloudflare Workers config
├── sandbox/
│   ├── app.py             # Modal Python App — sandbox web endpoints
│   └── requirements.txt
├── app/
│   ├── worker.ts          # Cloudflare Worker — Kimi/Ollama/Mistral proxy + sandbox proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/           # ChatContainer, ChatInput, MessageBubble, AgentStatusBar, WorkspacePanel, RepoAndChatSelector, RepoChatDrawer, SandboxExpiryBanner
│   │   │   ├── cards/          # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, FileSearchCard, CommitReviewCard, TestResultsCard, EditorCard, BrowserScreenshotCard, BrowserExtractCard, and more
│   │   │   ├── filebrowser/    # FileActionsSheet, CommitPushSheet, FileEditor, UploadButton
│   │   │   └── ui/             # shadcn/ui component library
│   │   ├── hooks/              # useChat, useSandbox, useScratchpad, useUserProfile, useGitHubAuth, useGitHubAppAuth, useRepos, useFileBrowser, useCodeMirror, useCommitPush, useTavilyConfig, useUsageTracking
│   │   ├── lib/                # Agent logic, tool protocols, git operations, web search, model catalog, prompts
│   │   ├── sections/           # OnboardingScreen, RepoPicker, FileBrowser, HomeScreen
│   │   └── types/              # TypeScript definitions
│   └── package.json
└── README.md
```

## License

MIT — see [LICENSE](LICENSE) for details.
