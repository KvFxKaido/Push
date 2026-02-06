# Push — AI Agent Context

Mobile-first AI coding agent with direct GitHub repo access. Chat with your codebase — review PRs, explore changes, and ship code from your phone.

## Project Overview

Push is a personal chat interface backed by role-based AI agents. Users select a repo, ask questions, and the agent reads code, analyzes PRs, runs code in a sandbox, and shows results as inline cards — all in a streaming conversation.

**Core Philosophy:**
- Chat-first — conversation is the primary interface
- Repo-locked context — agent only sees the selected repo
- Live pipeline — every agent step visible in real time
- Show, don't dump — rich inline cards instead of walls of text

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript 5.9, Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui (Radix primitives) |
| AI | Kimi For Coding, Ollama Cloud, or Mistral Vibe (user picks backend in Settings) |
| Backend | Cloudflare Workers (TypeScript) |
| Sandbox | Modal (serverless Python containers) |
| APIs | GitHub REST API |
| PWA | Service Worker, Web App Manifest |

## Architecture

### Role-Based Agent System

Models are replaceable; roles are locked. The user never picks a model.

| Role | Model | Responsibility |
|------|-------|----------------|
| **Orchestrator** | Kimi K2.5 | Conversational lead, interprets intent, coordinates specialists, delegates to Coder |
| **Coder** | Kimi K2.5 | Autonomous code implementation in sandbox, writes/edits/runs code |
| **Auditor** | Kimi K2.5 | Risk specialist, pre-commit gate, binary SAFE/UNSAFE verdict (cannot bypass) |

### AI Backends

Three providers are supported, all using OpenAI-compatible SSE streaming:

| Provider | Endpoint | Default Model |
|----------|----------|---------------|
| Kimi For Coding | api.kimi.com | kimi-k2.5 |
| Ollama Cloud | ollama.com | kimi-k2.5:cloud |
| Mistral Vibe | api.mistral.ai | devstral-small-latest |

API keys are configurable at runtime via the Settings UI. When 2 or more API keys are set, a backend picker appears in the UI allowing users to switch providers mid-conversation. Production uses Cloudflare Worker proxies at `/api/kimi/chat`, `/api/ollama/chat`, and `/api/mistral/chat` to route requests securely without exposing keys client-side.

### Tool Protocol

Tools are prompt-engineered — the system prompt defines available tools and JSON format. The agent emits JSON tool blocks, the client executes them, injects results as synthetic messages, and re-calls the LLM (up to 3 rounds for Orchestrator, 5 for Coder).

The Orchestrator can delegate complex coding tasks to the Coder sub-agent via the `delegate_coder` tool. The Coder runs autonomously in a sandboxed environment with up to 5 rounds of tool execution to complete the task, then returns the results to the Orchestrator.

### Scratchpad

A shared notepad that both the user and AI can read/write. Content persists in localStorage and is always injected into the system prompt. Tools: `set_scratchpad` (replace) and `append_scratchpad` (add). Useful for consolidating ideas, requirements, and decisions throughout a session.

### Rolling Window

Context is trimmed to the last 30 messages before sending to the LLM. Tool call/result pairs are kept together to prevent orphaned results. This reduces latency and keeps the LLM focused on recent conversation.

### Data Flow

1. **Onboard** → Validate GitHub PAT
2. **Pick repo** → Select from user's repos (hard-locked context)
3. **Chat** → Ask about PRs, changes, codebase
4. **Tools** → JSON tool blocks → execute against GitHub API or sandbox
5. **Scratchpad** → Shared notepad for ideas/requirements (user + AI can edit)
6. **Sandbox** → Clone repo to container, run commands, edit files
7. **Coder** → Autonomous coding task execution
8. **Auditor** → Every commit gets safety verdict before landing
9. **Cards** → Structured results render as inline cards

## Directory Structure

```
Push/
├── AGENTS.md              # This file — AI assistant context
├── CLAUDE.md              # Detailed architecture and conventions
├── README.md              # Project overview and setup
├── wrangler.jsonc         # Cloudflare Workers config
├── app/
│   ├── worker.ts          # Cloudflare Worker — AI proxy + sandbox proxy
│   ├── src/
│   │   ├── App.tsx        # Root component, screen state machine
│   │   ├── components/
│   │   │   ├── chat/      # Chat UI (ChatContainer, ChatInput, MessageBubble, ScratchpadDrawer)
│   │   │   ├── cards/     # Rich inline cards (PRCard, SandboxCard, DiffPreviewCard, etc.)
│   │   │   ├── filebrowser/  # File browser components
│   │   │   └── ui/        # shadcn/ui component library
│   │   ├── hooks/         # React hooks (useChat, useSandbox, useGitHubAuth, etc.)
│   │   ├── lib/           # Core logic and agent modules
│   │   │   ├── orchestrator.ts    # System prompt, SSE streaming, rolling window
│   │   │   ├── github-tools.ts    # GitHub tool protocol
│   │   │   ├── sandbox-tools.ts   # Sandbox tool definitions
│   │   │   ├── scratchpad-tools.ts # Scratchpad tool definitions + security
│   │   │   ├── sandbox-client.ts  # HTTP client for sandbox API
│   │   │   ├── tool-dispatch.ts   # Unified tool dispatch
│   │   │   ├── coder-agent.ts     # Coder sub-agent loop
│   │   │   ├── auditor-agent.ts   # Auditor review + verdict
│   │   │   ├── workspace-context.ts  # Active repo context builder
│   │   │   ├── providers.ts       # AI provider config
│   │   │   ├── prompts.ts         # System prompts
│   │   │   └── utils.ts           # Utility functions (cn)
│   │   ├── sections/      # Screen components
│   │   │   ├── OnboardingScreen.tsx
│   │   │   ├── RepoPicker.tsx
│   │   │   └── FileBrowser.tsx
│   │   ├── types/         # TypeScript type definitions
│   │   │   └── index.ts   # All shared types
│   │   └── main.tsx       # App entry point
│   ├── package.json
│   └── vite.config.ts
└── sandbox/
    ├── app.py             # Modal Python App — sandbox web endpoints
    └── requirements.txt
```

## Key Files Reference

### Core Logic (lib/)

| File | Purpose |
|------|---------|
| `lib/orchestrator.ts` | SSE streaming, think-token parsing, rolling window context |
| `lib/github-tools.ts` | GitHub tool protocol, `delegate_coder` function |
| `lib/sandbox-tools.ts` | Sandbox tool definitions |
| `lib/scratchpad-tools.ts` | Scratchpad tools, prompt injection escaping |
| `lib/sandbox-client.ts` | HTTP client for `/api/sandbox/*` endpoints |
| `lib/tool-dispatch.ts` | Unified dispatch for all tools |
| `lib/coder-agent.ts` | Coder autonomous loop (up to 5 rounds) |
| `lib/auditor-agent.ts` | Auditor review + binary verdict |
| `lib/workspace-context.ts` | Active repo context builder |
| `lib/providers.ts` | AI provider config (Kimi/Ollama/Mistral) |

### Hooks (hooks/)

| File | Purpose |
|------|---------|
| `hooks/useChat.ts` | Chat state, message history, tool execution loop |
| `hooks/useSandbox.ts` | Sandbox session lifecycle |
| `hooks/useScratchpad.ts` | Shared notepad state, localStorage persistence |
| `hooks/useGitHubAuth.ts` | PAT validation, OAuth flow |
| `hooks/useRepos.ts` | Repo list fetching, activity detection |
| `hooks/useActiveRepo.ts` | Active repo selection + persistence |
| `hooks/useFileBrowser.ts` | File browser state and navigation |

## Coding Conventions

### TypeScript

- Strict TypeScript with explicit return types on exported functions
- Types centralized in `types/index.ts`
- Use discriminated unions for card types

### React

- Functional components with hooks
- Custom hooks encapsulate data fetching
- State machines for screen management

### Styling

- Tailwind CSS for all styling
- shadcn/ui components in `components/ui/`
- Use `cn()` utility for class merging

### File Organization

- Gate screens → `sections/`
- Chat components → `components/chat/`
- Inline cards → `components/cards/`
- API clients and orchestration → `lib/`
- Agent modules → `lib/`

### Naming

- Components: PascalCase (`ChatContainer.tsx`)
- Hooks: camelCase with `use` prefix (`useChat.ts`)
- Utilities: camelCase (`orchestrator.ts`)
- Types: PascalCase (`ChatCard`, `SandboxCardData`)

## Environment Variables

### Local Development (app/.env)

```env
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth
VITE_MOONSHOT_API_KEY=...         # Optional — for Kimi backend
VITE_OLLAMA_API_KEY=...           # Optional — for Ollama Cloud backend
VITE_MISTRAL_API_KEY=...          # Optional — for Mistral Vibe backend
```

### Cloudflare Worker Secrets

```bash
npx wrangler secret put MOONSHOT_API_KEY          # Kimi API key
npx wrangler secret put OLLAMA_API_KEY            # Ollama Cloud API key
npx wrangler secret put MISTRAL_API_KEY           # Mistral API key
npx wrangler secret put MODAL_SANDBOX_BASE_URL    # https://user--push-sandbox
```

## Development Commands

```bash
# Install dependencies
cd app && npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Deploy Cloudflare Worker (from repo root)
npx wrangler deploy

# Deploy Modal sandbox
cd sandbox && python -m modal deploy app.py
```

## Demo Mode

Without API keys, the app runs in demo mode with mock repos and welcome message. This is the escape hatch for quick UI testing.

## Design Principles

1. **Mobile first, not mobile friendly** — Built for phones first
2. **One app, not four** — If you leave the app to finish, it failed
3. **Chat is the interface** — Conversation is primary input
4. **Live pipeline** — Every agent step visible in real time
5. **Write-first mobile** — Auditor earns trust, not access restrictions
6. **Quiet confidence** — Fewer words, structured output
7. **Show, don't dump** — Rich inline cards over text walls

## Security Notes

- API keys never exposed to client in production (Worker proxies all AI calls)
- Auditor gate cannot be bypassed — every commit requires SAFE verdict
- Auditor defaults to UNSAFE on any error (fail-safe design)
- Repo context is hard-locked — Orchestrator only sees selected repo
- Sandbox containers auto-terminate after 30 minutes
- Scratchpad content is escaped to prevent prompt injection
- Scratchpad content capped at 50KB to prevent DoS via tool flooding
- Rolling window keeps last 30 messages, preserving tool call/result pairs

## Common Tasks

### Adding a New Card Type

1. Add card data type to `types/index.ts`
2. Add to `ChatCard` discriminated union
3. Create card component in `components/cards/`
4. Add case to card renderer
5. Update tool execution to return the new card type

### Adding a New Tool

1. Define tool interface in `types/index.ts`
2. Add tool definition to appropriate tool file
3. Add `detect*ToolCall()` and `execute*ToolCall()` functions
4. Wire up in `tool-dispatch.ts`
5. Update system prompt to include new tool

### Adding a New Screen

1. Create component in `sections/`
2. Add screen to `AppScreen` type
3. Add case to state machine in `App.tsx`
4. Add navigation trigger from existing screen

## External Dependencies

| Service | Purpose | Endpoint |
|---------|---------|----------|
| Kimi For Coding | AI completions | api.kimi.com |
| Ollama Cloud | AI completions | ollama.com |
| Mistral Vibe | AI completions | api.mistral.ai |
| GitHub API | Repo operations | api.github.com |
| Modal | Sandbox containers | `{base}-{function}.modal.run` |

---

**Reference:** See `CLAUDE.md` for more detailed architecture and implementation notes.

## Scratchpad Tools

You have access to a shared scratchpad — a persistent notepad that both you and the user can see and edit.

### set_scratchpad
Replace the entire scratchpad content:
```json
{"tool": "set_scratchpad", "content": "## Requirements\n- Feature A\n- Feature B"}
```

### append_scratchpad
Add to the existing content:
```json
{"tool": "append_scratchpad", "content": "## New Section\n- Added item"}
```
