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
| AI | Ollama Cloud + OpenRouter (dual provider, runtime-switchable) |
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
VITE_OLLAMA_CLOUD_API_KEY=...     # Optional — or paste in Settings UI
VITE_OPENROUTER_API_KEY=...       # Optional — or paste in Settings UI (takes priority over Ollama)
VITE_GITHUB_TOKEN=...             # Optional — higher GitHub rate limits
```

Without any AI keys the app runs in demo mode with mock repos and a welcome message.

## Production

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/chat` to Ollama Cloud with the API key stored as a runtime secret. Static assets are served by the Cloudflare Assets layer.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Project Structure

```
Diff/
├── CLAUDE.md              # AI assistant context (architecture, conventions)
├── wrangler.jsonc         # Cloudflare Workers config
├── app/
│   ├── worker.ts          # Cloudflare Worker — streaming proxy
│   ├── src/
│   │   ├── components/
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, RepoSelector
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # useChat, useGitHubAuth, useRepos, useActiveRepo, useOllamaKey, useOpenRouterKey
│   │   ├── lib/           # orchestrator, github-tools, workspace-context
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
4. **Tools** — the agent emits JSON tool blocks, the client executes them against GitHub's API, injects results, and re-prompts (up to 3 rounds)
5. **Cards** — structured results render as inline cards in the chat

## Architecture

Role-based agent system. Models are replaceable; roles are not.

- **Orchestrator (Kimi K2.5)** — conversational lead, tool orchestration
- **Coder (GLM 4.5 Air)** — code implementation and edits (OpenRouter)
- **Auditor (DeepSeek R1T Chimera)** — risk review, pre-commit gate (OpenRouter)

AI runs through two providers: OpenRouter (priority) and Ollama Cloud (fallback). Both keys are configurable at runtime via the Settings UI. Production uses the Cloudflare Worker proxy for Ollama Cloud.

## License

This project is private and not currently licensed for redistribution.
