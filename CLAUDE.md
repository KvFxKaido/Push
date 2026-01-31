# Diff — Mobile GitHub Command Center

Personal, mobile-first PWA that replaces GitSync, GitHub mobile, Claude, and Codex with one app for repo monitoring, direct edits to main, and live pipeline visibility.

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

Role-based agent system. Models are replaceable. Roles are not.

- **Orchestrator** — Routes intent, normalizes input, sequences workflows, never does the work
- **Coder** — Writes/edits code via GitHub API, only acts when summoned
- **Auditor** — Pre-commit gate, risk review, binary verdict

All AI runs through Ollama Cloud. No other AI providers.

## Project Layout

```
app/src/
  components/ui/   # shadcn/ui component library
  hooks/           # React hooks (GitHub, analysis, auth, mobile)
  lib/             # API clients (ollama, providers, prompts, utils)
  sections/        # Screen components (Home, Running, Results)
  types/           # TypeScript type definitions
  App.tsx          # Root component, screen routing, state
```

## Key Files

- `lib/providers.ts` — AI provider config and routing
- `lib/ollama.ts` — Ollama Cloud API client
- `lib/prompts.ts` — Analysis prompts and mock data
- `hooks/useAnalysis.ts` — Analysis orchestration hook
- `hooks/useGitHub.ts` — GitHub API data fetching
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
3. Live pipeline — every action visible in real time, Manus-style
4. One action per screen
5. Write-first mobile — Auditor earns trust, not access restrictions
6. No chat by default

## Conventions

- Screens go in `sections/`, one per file
- API clients go in `lib/`, one per provider
- Hooks encapsulate all data fetching and state for a concern
- Types are centralized in `types/index.ts`
- Demo mode falls back to `MOCK_ANALYSIS` when API keys are missing
- Provider architecture supports adding new AI providers without changing hooks or screens
