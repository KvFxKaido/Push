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
| AI | Multi-backend: Kimi K2.5, Ollama, Mistral (user picks, all roles) |
| Backend | Cloudflare Workers (TypeScript) |
| Sandbox | Modal (serverless Python containers) |
| APIs | GitHub REST API |
| PWA | Service Worker, Web App Manifest |

## Architecture

### Role-Based Agent System

The active backend serves all three roles. The user picks a backend in Settings; all agents use it.

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Conversational lead, interprets intent, delegates to Coder |
| **Coder** | Autonomous code implementation in sandbox (unbounded rounds, 90s timeout per round) |
| **Auditor** | Pre-commit risk review — binary SAFE/UNSAFE verdict (fail-safe) |

### AI Backends

Three providers are supported for the Orchestrator, all using OpenAI-compatible SSE streaming:

| Provider | Endpoint | Default Model | Use Case |
|----------|----------|---------------|----------|
| **Kimi For Coding** | api.kimi.com | k2.5 | Default provider |
| **Ollama Cloud** | ollama.com | gemini-3-flash-preview | Open models |
| **Mistral Vibe** | api.mistral.ai | devstral-small-latest | Mistral models |

The active backend serves all three roles (Orchestrator, Coder, Auditor). Any single API key is sufficient for full functionality.

API keys are configurable at runtime via Settings. When 2+ keys are set, a backend picker appears. Provider selection is locked per chat after the first user message; start a new chat to switch providers. Production uses Cloudflare Worker proxies at `/api/kimi/chat`, `/api/ollama/chat`, and `/api/mistral/chat`.

### Tool Protocol

Tools are prompt-engineered — the system prompt defines available tools and JSON format. The agent emits JSON tool blocks, the client executes them, injects results as synthetic messages, and re-calls the LLM. Both the Orchestrator and Coder tool loops are unbounded — they continue until the model stops emitting tool calls (or the user aborts). The Coder has a 90s per-round timeout and 60KB context cap as safety nets.

The Orchestrator can delegate complex coding tasks to the Coder sub-agent via the `delegate_coder` tool. The Coder runs autonomously with its own tool loop in the sandbox, then returns results to the Orchestrator.

### Browser Tools (Optional)

Push includes optional sandbox browser tools backed by Browserbase:

- `sandbox_browser_screenshot` — capture a webpage screenshot and render a preview card
- `sandbox_browser_extract` — extract main text from a URL, with optional `selector:` / `css:` instruction prefixes

These tools are prompt-gated by `VITE_BROWSER_TOOL_ENABLED=true` and execute through Worker routes `/api/sandbox/browser-screenshot` and `/api/sandbox/browser-extract`.

### Browserbase Status

From `documents/Browserbase Integration Spike.md`:

- [x] v1 complete and validated on deployed Worker + Modal
- [x] `sandbox_browser_screenshot` shipped (card UI + metadata)
- [x] `sandbox_browser_extract` shipped (card UI + bounded text extraction)
- [x] Browserbase credentials injected server-side via Worker secrets
- [x] Guardrails shipped (URL allowlist, private-network block, output caps)
- [x] Test suite shipped (97 tests across tool/client/routes/types)
- [ ] Validate on real mobile cellular networks (iOS Safari + Android Chrome)
- [ ] Progressively enable `VITE_BROWSER_TOOL_ENABLED` after latency/error checks

### Scratchpad

A shared notepad that both the user and AI can read/write. Content persists in localStorage and is always injected into the system prompt. Tools: `set_scratchpad` (replace) and `append_scratchpad` (add). Useful for consolidating ideas, requirements, and decisions throughout a session.

### Rolling Window

Context uses a token budget with summarization. Older tool-heavy messages are compacted first, then oldest message pairs are trimmed if needed while preserving critical context.

### Project Instructions (Two-Phase Loading)

When the user selects a repo, the app fetches project instruction files via the GitHub REST API (tries `AGENTS.md`, then `CLAUDE.md` as fallback) and injects the content into the Orchestrator and Coder system prompts. When a sandbox becomes ready later, the app re-reads from the sandbox filesystem (which may have local edits) to upgrade the content. This ensures agents have project context from the first message — no sandbox required.

### Data Flow

1. **Onboard** → Connect via GitHub App (recommended) or GitHub PAT
2. **Pick repo** → Select from user's repos (hard-locked context)
3. **Chat** → Ask about PRs, changes, codebase
4. **Tools** → JSON tool blocks → execute against GitHub API or sandbox
5. **Scratchpad** → Shared notepad for ideas/requirements (user + AI can edit)
6. **Sandbox** → Clone repo to container, run commands, edit files
7. **Coder** → Autonomous coding task execution (uses active backend)
8. **Auditor** → Every commit gets safety verdict (uses active backend)
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
│   │   │   ├── coder-agent.ts     # Coder sub-agent (uses active backend)
│   │   │   ├── auditor-agent.ts   # Auditor review (uses active backend)
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
| `lib/orchestrator.ts` | SSE streaming, think-token parsing, token-budget context management |
| `lib/github-tools.ts` | GitHub tool protocol, `delegate_coder`, `fetchProjectInstructions` |
| `lib/sandbox-tools.ts` | Sandbox tool definitions |
| `lib/scratchpad-tools.ts` | Scratchpad tools, prompt injection escaping |
| `lib/sandbox-client.ts` | HTTP client for `/api/sandbox/*` endpoints |
| `lib/tool-dispatch.ts` | Unified dispatch for all tools |
| `lib/coder-agent.ts` | Coder autonomous loop (uses active backend) |
| `lib/auditor-agent.ts` | Auditor review + verdict (fail-safe, uses active backend) |
| `lib/workspace-context.ts` | Active repo context builder |
| `lib/providers.ts` | AI provider config and role model mapping |

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
# At least one AI key is needed (any provider works for all roles)
VITE_MOONSHOT_API_KEY=...         # Kimi API key
VITE_OLLAMA_API_KEY=...           # Ollama Cloud API key
VITE_MISTRAL_API_KEY=...          # Mistral API key

# GitHub
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth

# Browser tools (optional)
VITE_BROWSER_TOOL_ENABLED=true    # Expose browser tools in agent prompts
VITE_API_PROXY_TARGET=http://127.0.0.1:8787  # Vite proxy target for local Worker API
```

### Cloudflare Worker Secrets

```bash
# Required
npx wrangler secret put MOONSHOT_API_KEY          # Kimi API key

# Optional (Orchestrator alternatives)
npx wrangler secret put OLLAMA_API_KEY            # Ollama Cloud API key
npx wrangler secret put MISTRAL_API_KEY           # Mistral API key

npx wrangler secret put MODAL_SANDBOX_BASE_URL    # https://user--push-sandbox
npx wrangler secret put BROWSERBASE_API_KEY       # Browserbase API key (for browser tools)
npx wrangler secret put BROWSERBASE_PROJECT_ID    # Browserbase project id
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

Without any API key, the app runs in demo mode with mock repos and welcome message. Full functionality (Coder, Auditor, sandbox) requires at least one AI provider key. This is the escape hatch for quick UI testing.

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
- Browserbase credentials are injected server-side by the Worker (never exposed to client)
- Auditor gate cannot be bypassed — every commit requires SAFE verdict
- Auditor defaults to UNSAFE on any error (fail-safe design)
- Repo context is hard-locked — Orchestrator only sees selected repo
- Sandbox containers auto-terminate after 30 minutes
- Browser tools validate URL shape/protocol and reject private-network targets
- Scratchpad content is escaped to prevent prompt injection
- Scratchpad content capped at 50KB to prevent DoS via tool flooding
- Context management uses token-budget summarization and preserves tool call/result pairing when trimming

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
| Kimi For Coding | AI completions (all roles) | api.kimi.com |
| Ollama Cloud | AI completions (all roles) | ollama.com |
| Mistral Vibe | AI completions (all roles) | api.mistral.ai |
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
