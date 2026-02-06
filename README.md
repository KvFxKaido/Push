# Push

Mobile-first AI coding agent with direct GitHub repo access. Chat with your codebase — review PRs, explore changes, and ship code from your phone.

## What It Does

Push is a personal chat interface backed by role-based AI agents. Select a repo, ask questions, and the agent reads your code, analyzes PRs, and shows results as inline cards — all in a streaming conversation.

- **Chat-first** — conversation is the primary interface, not forms or dashboards
- **Repo-locked context** — select a repo and the agent only sees that repo
- **Tool protocol** — the agent calls GitHub's API mid-conversation (PRs, commits, diffs)
- **Scratchpad** — shared notepad for accumulating ideas, requirements, and decisions throughout a session
- **Streaming** — responses arrive token-by-token with visible thinking
- **Demo mode** — works with mock data when no credentials are configured

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Kimi For Coding or Ollama Cloud (user picks backend) |
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

Create `app/.env` for local development, or paste keys in the Settings UI at runtime:

```env
VITE_MOONSHOT_API_KEY=...         # Optional — Kimi key, or paste in Settings UI (sk-kimi-...)
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud key, or paste in Settings UI
VITE_GITHUB_TOKEN=...             # Optional — PAT for GitHub API access
```

Without any AI key the app runs in demo mode with mock repos and a welcome message. When both Kimi and Ollama keys are set, a backend picker appears in Settings.

## GitHub Authentication

Push supports two authentication methods:

### Option 1: GitHub App (Recommended)

Install the Push GitHub App and authorize access to your repos. Tokens refresh automatically — no manual management needed.

### Option 2: Personal Access Token

Create a PAT with `repo` scope and paste it in the Settings UI. Simpler setup, but tokens can expire and need manual rotation.

## Production

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/kimi/chat` to Kimi For Coding, `/api/ollama/chat` to Ollama Cloud, and `/api/sandbox/*` to Modal web endpoints, with API keys stored as runtime secrets. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Project Structure

```
Push/
├── CLAUDE.md              # AI assistant context (architecture, conventions)
├── wrangler.jsonc         # Cloudflare Workers config
├── sandbox/
│   ├── app.py             # Modal Python App — sandbox web endpoints
│   └── requirements.txt
├── app/
│   ├── worker.ts          # Cloudflare Worker — Kimi/Ollama proxy + sandbox proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, RepoSelector
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, etc.
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # useChat, useSandbox, useScratchpad, useGitHubAuth, useGitHubAppAuth, useRepos
│   │   ├── lib/           # orchestrator, tool-dispatch, scratchpad-tools, sandbox-client, coder-agent
│   │   ├── sections/      # OnboardingScreen, RepoPicker
│   │   ├── types/         # TypeScript type definitions
│   │   └── App.tsx        # Screen state machine (onboarding → repo-picker → chat)
│   ├── vite.config.ts
│   └── package.json
```

## How It Works

1. **Onboard** — authenticate via GitHub App or PAT
2. **Pick a repo** — select from your repos, search by name
3. **Chat** — ask about PRs, recent changes, codebase structure
4. **Tools** — the agent emits JSON tool blocks, the client executes them against GitHub's API or sandbox, injects results, and re-prompts (up to 3 rounds)
5. **Scratchpad** — open a shared notepad to consolidate ideas; both you and the agent can read/write
6. **Sandbox** — start a sandbox to clone the repo into a container, then run commands, edit files, and test changes
7. **Coder** — describe a coding task and the Orchestrator delegates to the Coder agent, which works autonomously in the sandbox
8. **Auditor** — every commit goes through the Auditor for a safety verdict (SAFE/UNSAFE) before landing
9. **Cards** — structured results render as inline cards (terminal output, diff preview, audit verdict, PR details, etc.)

## Architecture

Role-based agent system. Models are replaceable; roles are not.

- **Orchestrator** — conversational lead, tool orchestration, Coder delegation
- **Coder** — autonomous code implementation in sandbox
- **Auditor** — pre-commit safety gate, binary verdict

Two AI backends are supported: **Kimi For Coding** (`api.kimi.com`) and **Ollama Cloud** (`ollama.com`). Both use OpenAI-compatible SSE streaming. The active backend serves all three roles. API keys are configurable at runtime via the Settings UI — when both are set, users pick which backend to use. Default Ollama model: `kimi-k2.5:cloud`. Production uses Cloudflare Worker proxies for both backends and Modal sandbox.

## License

This project is licensed under the [MIT License](LICENSE).