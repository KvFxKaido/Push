# Push — Mobile AI Coding Agent

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
- **Multi-backend AI** (user picks in Settings):
  - Kimi For Coding (Kimi K2.5 via api.kimi.com, OpenAI-compatible SSE)
  - Ollama Cloud (open models on cloud GPUs via ollama.com, OpenAI-compatible SSE)
- Modal (serverless containers) for sandbox code execution
- Cloudflare Workers (streaming proxy + sandbox proxy)
- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. The user never picks a model — they pick a backend.

- **Orchestrator** — Conversational lead, interprets user intent, coordinates specialists, assembles results. The voice of the app.
- **Coder** — Code implementation and execution engine. Writes, edits, and runs code in a sandbox.
- **Auditor** — Risk specialist, pre-commit gate, binary verdict. Cannot be bypassed.

**AI backends:** Two providers are supported — **Kimi For Coding** (`api.kimi.com`) and **Ollama Cloud** (`ollama.com`). Both use OpenAI-compatible SSE streaming. API keys are configurable at runtime via the Settings UI — no restart needed. When both keys are set, a backend picker appears in Settings. The active backend serves all three roles. Default Ollama model is `kimi-k2.5:cloud`. Production uses Cloudflare Worker proxies at `/api/kimi/chat` and `/api/ollama/chat`.

**Onboarding gate:** Users must validate a GitHub PAT and select an active repo before chatting. Demo mode is an escape hatch with mock data. App state machine: `onboarding → repo-picker → chat`.

**Tool protocol:** Tools are prompt-engineered — the system prompt defines available tools and JSON format. The orchestrator detects JSON tool blocks in responses, executes them against GitHub's API, injects results as synthetic messages, and re-calls the LLM (up to 3 rounds). Sandbox tools use the same JSON block pattern, detected by a unified tool dispatch layer.

**Sandbox:** Modal (serverless containers) provides a persistent Linux environment per session. The repo is cloned into `/workspace`. The Coder reads/writes files, runs commands, and gets diffs — all via sandbox tools. The Cloudflare Worker proxies sandbox requests to Modal web endpoints (keeps Modal auth server-side). Containers auto-terminate after 30 min.

**Coder delegation:** The Orchestrator can delegate coding tasks to the Coder via `delegate_coder`. The Coder runs autonomously (up to 5 rounds) with its own tool loop in the sandbox, then returns a summary + cards to the Orchestrator.

**Auditor gate:** Every `sandbox_commit` runs through the Auditor first. The Auditor reviews the diff and returns a binary verdict (SAFE/UNSAFE). UNSAFE blocks the commit. The Auditor defaults to UNSAFE on any error (fail-safe).

**Repo hard lock:** The Orchestrator only sees the active repo in its context. Other repos are stripped entirely. Repo switching is UI-only via the header dropdown.

**Scratchpad:** A shared notepad that both the user and the LLM can read/write. User opens via button in ChatInput, the LLM updates via `set_scratchpad` / `append_scratchpad` tools. Content persists in localStorage and is always injected into the system prompt. Useful for consolidating ideas, requirements, and decisions throughout a session. Content is escaped to prevent prompt injection.

**Rolling window:** Context is trimmed to the last 30 messages before sending to the LLM. Tool call/result pairs are kept together to prevent orphaned results. This reduces latency and keeps the LLM focused on recent conversation without losing critical tool context.

## Project Layout

```
app/src/
  components/chat/   # Chat UI (ChatContainer, ChatInput, MessageBubble, ScratchpadDrawer, etc.)
  components/cards/  # Rich inline cards (PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, etc.)
  components/ui/     # shadcn/ui component library
  hooks/             # React hooks (useChat, useGitHubAuth, useRepos, useActiveRepo, useSandbox, useScratchpad, etc.)
  lib/               # Orchestrator, tool protocol, sandbox client, agent modules, workspace context
  sections/          # Screen components (OnboardingScreen, RepoPicker)
  types/             # TypeScript type definitions
  App.tsx            # Root component, screen state machine
app/worker.ts        # Cloudflare Worker — streaming proxy to Kimi/Ollama + sandbox proxy to Modal
sandbox/app.py       # Modal Python App — 6 web endpoints for sandbox CRUD
sandbox/requirements.txt
wrangler.jsonc       # Cloudflare Workers config (repo root)
```

## Key Files

- `lib/orchestrator.ts` — System prompt, multi-backend streaming (Kimi + Ollama SSE), think-token parsing, provider routing, rolling window context management
- `lib/github-tools.ts` — GitHub tool protocol (prompt-engineered function calling via JSON blocks) + `delegate_coder`
- `lib/sandbox-tools.ts` — Sandbox tool definitions, detection, execution, `SANDBOX_TOOL_PROTOCOL` prompt
- `lib/sandbox-client.ts` — HTTP client for `/api/sandbox/*` endpoints (thin fetch wrappers)
- `lib/scratchpad-tools.ts` — Scratchpad tool definitions (`set_scratchpad`, `append_scratchpad`), prompt injection escaping
- `lib/tool-dispatch.ts` — Unified tool dispatch (GitHub + Sandbox + Scratchpad + delegation)
- `lib/coder-agent.ts` — Coder sub-agent loop (up to 5 autonomous rounds, uses active backend)
- `lib/auditor-agent.ts` — Auditor review + verdict (fail-safe to UNSAFE, uses active backend)
- `lib/workspace-context.ts` — Builds active repo context for system prompt injection
- `lib/providers.ts` — AI provider configs (Kimi + Ollama), role-to-model mapping, backend preference
- `hooks/useChat.ts` — Chat state, message history, unified tool execution loop, Coder delegation, scratchpad integration
- `hooks/useSandbox.ts` — Sandbox session lifecycle (idle → creating → ready → error)
- `hooks/useScratchpad.ts` — Shared notepad state, localStorage persistence, content size limits
- `hooks/useGitHubAuth.ts` — PAT validation, OAuth flow, mount re-validation
- `hooks/useActiveRepo.ts` — Active repo selection + localStorage persistence
- `hooks/useRepos.ts` — Repo list fetching, sync tracking, activity detection
- `hooks/useMoonshotKey.ts` — Kimi For Coding API key management (localStorage + env fallback)
- `hooks/useOllamaConfig.ts` — Ollama Cloud API key + model name management (localStorage + env fallback)
- `types/index.ts` — All shared TypeScript types (includes card data types for sandbox, diff preview, audit verdict)

## Environment Variables

```env
VITE_MOONSHOT_API_KEY=...         # Optional — Kimi key, can also be set via Settings UI (sk-kimi-...)
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud key, can also be set via Settings UI
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth token exchange
```

**Worker secrets (Cloudflare):**
- `MOONSHOT_API_KEY` — Kimi For Coding API key (production proxy, starts with `sk-kimi-`)
- `OLLAMA_API_KEY` — Ollama Cloud API key (production proxy)
- `MODAL_SANDBOX_BASE_URL` — Modal app base URL (e.g. `https://youruser--push-sandbox`). Endpoints follow pattern `{base}-{function}.modal.run`

**API keys:** Kimi and Ollama Cloud keys can be set via env vars or pasted in the Settings UI at runtime (stored in localStorage). Settings UI keys override env vars. When both are set, the user picks which backend to use via a toggle in Settings. The preference is stored in localStorage.

**Production:** Cloudflare Worker at `app/worker.ts` holds `MOONSHOT_API_KEY`, `OLLAMA_API_KEY`, and `MODAL_SANDBOX_BASE_URL` as runtime secrets. The client never sees them. The worker proxies `/api/kimi/chat` to `api.kimi.com` (with `User-Agent: claude-code/1.0.0` for Kimi's agent gating) and `/api/ollama/chat` to `ollama.com/v1/chat/completions`.

Without any API keys (dev) the app runs in demo mode with mock data. Without `MODAL_SANDBOX_BASE_URL` the sandbox button shows but returns a 503.

## Design Principles

1. Mobile first, not mobile friendly
2. One app, not four — if you leave the app to finish the job, the app failed
3. Chat is the interface — conversation is the primary input
4. Live pipeline — every agent step visible in real time, Manus-style
5. Write-first mobile — Auditor earns trust, not access restrictions
6. Quiet confidence — fewer words, structured output, no over-explaining
7. Show, don't dump — rich inline cards instead of walls of text

## Conventions

- Gate screens go in `sections/`, chat components in `components/chat/`, inline cards in `components/cards/`
- API clients and orchestration logic go in `lib/`
- Agent modules (coder-agent, auditor-agent) go in `lib/` and export a single `run*()` function
- Hooks encapsulate all data fetching and state for a concern
- Types are centralized in `types/index.ts`
- Tool detection/execution follows the pattern: `detect*ToolCall()` → `execute*ToolCall()`, unified via `tool-dispatch.ts`
- Demo mode falls back to mock repos when no GitHub PAT is set
- Errors surface in the UI — never swallowed silently
- Model selection is automatic — the Orchestrator routes to the right specialist
- Active repo is hard-locked — the Orchestrator's context only contains the selected repo
- Auditor defaults to UNSAFE on any error (fail-safe design)
