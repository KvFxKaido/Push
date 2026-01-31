# Diff — Mobile AI Coding Agent

ChatGPT with direct access to your repos. A personal, mobile-first chat interface backed by role-based AI agents that can read your code, write patches, run them in a sandbox, and commit to main.

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
- Ollama Cloud for all AI (flat subscription, no token metering)
- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. The user never picks a model.

- **Orchestrator (Kimi K2.5)** — Conversational lead, interprets user intent, coordinates specialists, assembles results. The voice of the app.
- **Coder (GLM 4.7)** — Code implementation and execution engine. Writes, edits, and runs code in a sandbox.
- **Auditor (Gemini 3 Pro)** — Risk specialist, pre-commit gate, binary verdict. Cannot be bypassed.

All AI runs through Ollama Cloud. No other AI providers.

**Vision:** Chat is the primary interface. The app is a conversation, not a dashboard. Structured screens (RepoDashboard, Results) become inline cards the agent renders in the chat.

## Project Layout

```
app/src/
  components/ui/   # shadcn/ui component library
  hooks/           # React hooks (GitHub, analysis, auth, mobile)
  lib/             # API clients (ollama, providers, prompts, utils)
  sections/        # Screen components (Home, RepoDashboard, Running, Results)
  types/           # TypeScript type definitions
  App.tsx          # Root component, screen routing, state
```

## Key Files

- `lib/providers.ts` — AI provider config and role-to-model mapping
- `lib/ollama.ts` — Ollama Cloud API client
- `lib/prompts.ts` — Analysis prompts and mock data
- `hooks/useAnalysis.ts` — Analysis orchestration hook
- `hooks/useGitHub.ts` — GitHub API data fetching
- `hooks/useRepos.ts` — Repo list fetching, sync tracking, activity detection
- `types/index.ts` — All shared TypeScript types

## Environment Variables

```env
VITE_OLLAMA_CLOUD_API_KEY=...     # Required for AI analysis
VITE_OLLAMA_CLOUD_API_URL=...     # Optional, defaults to https://api.ollama.com/v1/chat/completions
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth token exchange
```

Without API keys the app runs in demo mode with mock data.

## Design Principles

1. Mobile first, not mobile friendly
2. One app, not four — if you leave the app to finish the job, the app failed
3. Chat is the interface — conversation is the primary input
4. Live pipeline — every agent step visible in real time, Manus-style
5. Write-first mobile — Auditor earns trust, not access restrictions
6. Quiet confidence — fewer words, structured output, no over-explaining
7. Show, don't dump — rich inline cards instead of walls of text

## Conventions

- Screens go in `sections/`, one per file
- API clients go in `lib/`, one per provider
- Hooks encapsulate all data fetching and state for a concern
- Types are centralized in `types/index.ts`
- Demo mode falls back to `MOCK_ANALYSIS` when API keys are missing
- Errors surface in the UI — never swallowed silently
- Model selection is automatic — the Orchestrator routes to the right specialist
