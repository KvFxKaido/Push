# Diff

Mobile-first AI coding agent with direct GitHub repo access. Chat with your codebase — review PRs, explore changes, and ship code from your phone.

## What It Does

Diff is a personal chat interface backed by role-based AI agents. Select a repo, ask questions, and the agent reads your code, analyzes PRs, and shows results as inline cards — all in a streaming conversation.

- **Chat-first** — conversation is the primary interface, not forms or dashboards
- **Repo-locked context** — select a repo and the agent only sees that repo
- **Tool protocol** — the agent calls GitHub's API mid-conversation (PRs, commits, diffs)
- **Streaming** — responses arrive token-by-token with visible thinking
- **Demo mode** — works with mock data when no credentials are configured

## Tech Stack

| Layer | Tools |
|-------|-------|
| Framework | React 19, TypeScript 5.9 |
| Build | Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Kimi For Coding (Kimi K2.5 via api.kimi.com) |
| Sandbox | Modal (serverless containers) |
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
VITE_MOONSHOT_API_KEY=...         # Optional — or paste in Settings UI (sk-kimi-...)
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
```

Without a Kimi key the app runs in demo mode with mock repos and a welcome message.

## Production

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/kimi/chat` to Kimi For Coding and `/api/sandbox/*` to Modal web endpoints, with API keys stored as runtime secrets. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Project Structure

```
Diff/
├── CLAUDE.md              # AI assistant context (architecture, conventions)
├── wrangler.jsonc         # Cloudflare Workers config
├── sandbox/
│   ├── app.py             # Modal Python App — sandbox web endpoints
│   └── requirements.txt
├── app/
│   ├── worker.ts          # Cloudflare Worker — Kimi proxy + sandbox proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, RepoSelector
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, etc.
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # useChat, useSandbox, useGitHubAuth, useRepos, useActiveRepo
│   │   ├── lib/           # orchestrator, tool-dispatch, sandbox-client, coder-agent, auditor-agent
│   │   ├── sections/      # OnboardingScreen, RepoPicker
│   │   ├── types/         # TypeScript type definitions
│   │   └── App.tsx        # Screen state machine (onboarding → repo-picker → chat)
│   ├── vite.config.ts
│   └── package.json
```

## How It Works

1. **Onboard** — validate a GitHub PAT (calls `GET /user` to verify)
2. **Pick a repo** — select from your repos, search by name
3. **Chat** — ask about PRs, recent changes, codebase structure
4. **Tools** — the agent emits JSON tool blocks, the client executes them against GitHub's API or sandbox, injects results, and re-prompts (up to 3 rounds)
5. **Sandbox** — start a sandbox to clone the repo into a container, then run commands, edit files, and test changes
6. **Coder** — describe a coding task and the Orchestrator delegates to the Coder agent, which works autonomously in the sandbox
7. **Auditor** — every commit goes through the Auditor for a safety verdict (SAFE/UNSAFE) before landing
8. **Cards** — structured results render as inline cards (terminal output, diff preview, audit verdict, PR details, etc.)

## Architecture

Role-based agent system. Models are replaceable; roles are not.

- **Orchestrator (Kimi K2.5)** — conversational lead, tool orchestration, Coder delegation
- **Coder (Kimi K2.5)** — autonomous code implementation in sandbox
- **Auditor (Kimi K2.5)** — pre-commit safety gate, binary verdict

AI runs through a single provider: Kimi For Coding (`api.kimi.com`). The API key is configurable at runtime via the Settings UI. Production uses the Cloudflare Worker proxy for Kimi and Modal sandbox.

## License

This project is private and not currently licensed for redistribution.
