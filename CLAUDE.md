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

All AI runs through Ollama Cloud via Cloudflare Workers (streaming proxy). No other AI providers.

**Onboarding gate:** Users must validate a GitHub PAT and select an active repo before chatting. Demo mode is an escape hatch with mock data. App state machine: `onboarding → repo-picker → chat`.

**Tool protocol:** Ollama Cloud has no native function calling. Tools are prompt-engineered — the system prompt defines available tools and JSON format. The orchestrator detects JSON tool blocks in responses, executes them against GitHub's API, injects results as synthetic messages, and re-calls the LLM (up to 3 rounds).

**Repo hard lock:** Kimi only sees the active repo in its context. Other repos are stripped entirely. Repo switching is UI-only via the header dropdown.

## Project Layout

```
app/src/
  components/chat/  # Chat UI (ChatContainer, ChatInput, MessageBubble, RepoSelector)
  components/ui/    # shadcn/ui component library
  hooks/            # React hooks (useChat, useGitHubAuth, useRepos, useActiveRepo)
  lib/              # Orchestrator, tool protocol, workspace context, API clients
  sections/         # Screen components (OnboardingScreen, RepoPicker)
  types/            # TypeScript type definitions
  App.tsx           # Root component, screen state machine
app/worker.ts       # Cloudflare Worker — streaming proxy to Ollama Cloud
wrangler.jsonc      # Cloudflare Workers config (repo root)
```

## Key Files

- `lib/orchestrator.ts` — System prompt, Ollama Cloud streaming, think-token parsing
- `lib/github-tools.ts` — Tool protocol (prompt-engineered function calling via JSON blocks)
- `lib/workspace-context.ts` — Builds active repo context for system prompt injection
- `lib/providers.ts` — AI provider config and role-to-model mapping
- `hooks/useChat.ts` — Chat state, message history, tool execution loop
- `hooks/useGitHubAuth.ts` — PAT validation, OAuth flow, mount re-validation
- `hooks/useActiveRepo.ts` — Active repo selection + localStorage persistence
- `hooks/useRepos.ts` — Repo list fetching, sync tracking, activity detection
- `types/index.ts` — All shared TypeScript types

## Environment Variables

```env
VITE_OLLAMA_CLOUD_API_KEY=...     # Dev only — prod key is in Cloudflare secrets
VITE_OLLAMA_CLOUD_API_URL=...     # Optional, defaults to /ollama/api/chat (dev) or /api/chat (prod)
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth token exchange
```

**Production:** Cloudflare Worker at `app/worker.ts` holds `OLLAMA_CLOUD_API_KEY` as a runtime secret. The client never sees it.

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

- Gate screens go in `sections/`, chat components in `components/chat/`
- API clients and orchestration logic go in `lib/`
- Hooks encapsulate all data fetching and state for a concern
- Types are centralized in `types/index.ts`
- Demo mode falls back to mock repos when no GitHub PAT is set
- Errors surface in the UI — never swallowed silently
- Model selection is automatic — the Orchestrator routes to the right specialist
- Active repo is hard-locked — Kimi's context only contains the selected repo
