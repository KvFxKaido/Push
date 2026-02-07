# Push

Mobile-first AI coding agent with direct GitHub repo access. Chat with your codebase — review PRs, explore changes, and ship code from your phone.

Built specifically for the AI services that include API access in their subscriptions. No per-token billing. No surprise bills. One flat monthly fee, unlimited coding agent usage.

## What It Does

Push is a personal chat interface backed by role-based AI agents. Select a repo, ask questions, and the agent reads your code, analyzes PRs, and shows results as inline cards — all in a streaming conversation.

- **Chat-first** — conversation is the primary interface, not forms or dashboards
- **Repo-locked context** — select a repo and the agent only sees that repo
- **Tool protocol** — the agent calls GitHub's API mid-conversation (PRs, commits, diffs)
- **Scratchpad** — shared notepad for accumulating ideas, requirements, and decisions throughout a session
- **Streaming** — responses arrive token-by-token with visible thinking
- **Demo mode** — works with mock data when no credentials are configured

## Who It's For

Push is for developers who:

- **Hate burning API credits** — Predictable monthly costs, not per-token surprises
- **Already subscribe to AI services** — Use your existing Kimi, Mistral, or Ollama Cloud subscription (all include unlimited API access)
- **Want mobile-native workflows** — Review and ship code from your phone, not just your IDE
- **Like owning their tools** — Open source, self-hostable, no vendor lock-in

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
VITE_MOONSHOT_API_KEY=...         # Kimi For Coding (unlimited API with subscription)
VITE_MISTRAL_API_KEY=...          # Mistral Vibe (unlimited API with subscription)
VITE_OLLAMA_API_KEY=...           # Ollama Cloud (unlimited API with subscription)
VITE_GITHUB_TOKEN=...             # Optional — PAT for GitHub API access
```

Without any AI key the app runs in demo mode with mock repos and a welcome message. When 2+ provider keys are set, a backend picker appears in Settings.

## GitHub Authentication

Push supports two authentication methods:

### Option 1: GitHub App (Recommended)

Install the Push GitHub App and authorize access to your repos. Tokens refresh automatically — no manual management needed. You control exactly which repos the agent can access.

### Option 2: Personal Access Token

Create a PAT with `repo` scope and paste it in the Settings UI. Simpler setup, but tokens can expire and need manual rotation.

## Production

Deployed on Cloudflare Workers. The worker at `app/worker.ts` proxies `/api/kimi/chat` to Kimi For Coding, `/api/ollama/chat` to Ollama Cloud, `/api/mistral/chat` to Mistral Vibe, and `/api/sandbox/*` to Modal web endpoints, with API keys stored as runtime secrets. Static assets are served by the Cloudflare Assets layer. The Modal sandbox backend at `sandbox/app.py` is deployed separately via `modal deploy`.

```bash
cd app && npm run build
npx wrangler deploy     # from repo root
```

## Architecture

Role-based agent system. **Models are replaceable; roles are not.**

- **Orchestrator** — conversational lead, tool orchestration, delegates to Coder
- **Coder** — autonomous code implementation in sandbox
- **Auditor** — pre-commit safety gate, binary SAFE/UNSAFE verdict

Three AI backends are supported: **Kimi For Coding**, **Mistral Vibe**, and **Ollama Cloud**. All use OpenAI-compatible streaming. The active backend serves all three roles, and you can switch anytime via Settings.

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
│   │   │   ├── chat/      # ChatContainer, ChatInput, MessageBubble, RepoSelector
│   │   │   ├── cards/     # PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, etc.
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # useChat, useSandbox, useScratchpad, useGitHubAuth, useGitHubAppAuth, useRepos
│   │   ├── lib/           # Agent logic, tool protocols, git operations
│   │   ├── sections/      # OnboardingScreen, ConversationScreen
│   │   └── types/         # TypeScript definitions
│   └── package.json
└── README.md
```

## License

MIT — see [LICENSE](LICENSE) for details.
