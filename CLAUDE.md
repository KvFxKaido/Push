# Push — Mobile AI Coding Agent

ChatGPT with direct access to your repos. A personal, mobile-first chat interface backed by role-based AI agents that can read your code, write patches, run them in a sandbox, and commit/push changes.

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
  - Mistral Vibe (Devstral via api.mistral.ai, OpenAI-compatible SSE)
- Modal (serverless containers) for sandbox code execution
- Cloudflare Workers (streaming proxy + sandbox proxy)
- PWA with service worker and offline support

## Architecture

Role-based agent system. Models are replaceable. Roles are locked. The user never picks a model — they pick a backend.

- **Orchestrator** — Conversational lead, interprets user intent, coordinates specialists, assembles results. The voice of the app.
- **Coder** — Code implementation and execution engine. Writes, edits, and runs code in a sandbox.
- **Auditor** — Risk specialist, pre-commit gate, binary verdict. Cannot be bypassed.

**AI backends:** Three providers are supported — **Kimi For Coding** (`api.kimi.com`), **Ollama Cloud** (`ollama.com`), and **Mistral Vibe** (`api.mistral.ai`). All use OpenAI-compatible SSE streaming. API keys are configurable at runtime via the Settings UI — no restart needed. When 2+ keys are set, a backend picker appears in Settings. The active backend serves all three roles (Orchestrator, Coder, Auditor). Provider selection is locked per chat after the first user message; start a new chat to switch providers. Default Ollama model is `gemini-3-flash-preview`. Default Mistral model is `devstral-small-latest`. Production uses Cloudflare Worker proxies at `/api/kimi/chat`, `/api/ollama/chat`, and `/api/mistral/chat`.

**Onboarding gate:** Users connect with GitHub App (recommended) or GitHub PAT, then select an active repo before chatting. Demo mode is an escape hatch with mock data. App state machine: `onboarding → repo-picker → chat` (plus `file-browser` when sandbox files are open).

**Tool protocol:** Tools are prompt-engineered — the system prompt defines available tools and JSON format. The orchestrator detects JSON tool blocks in responses, executes them against GitHub's API, injects results as synthetic messages, and re-calls the LLM. Both the Orchestrator and Coder tool loops are unbounded — they continue until the model stops emitting tool calls (or the user aborts). Sandbox tools use the same JSON block pattern, detected by a unified tool dispatch layer.

**Browser tools (optional):** Sandbox browser operations are available via `sandbox_browser_screenshot` and `sandbox_browser_extract`. They are prompt-gated by `VITE_BROWSER_TOOL_ENABLED=true` and routed through Worker endpoints `/api/sandbox/browser-screenshot` and `/api/sandbox/browser-extract`. The Worker injects Browserbase credentials server-side.

**Browserbase status (from `documents/Browserbase Integration Spike.md`):**
- [x] v1 complete and validated on deployed Worker + Modal
- [x] `sandbox_browser_screenshot` shipped (card UI + metadata)
- [x] `sandbox_browser_extract` shipped (card UI + bounded text extraction)
- [x] Browserbase credentials injected server-side via Worker secrets
- [x] Guardrails shipped (URL allowlist, private-network block, output caps)
- [x] Test suite shipped (97 tests across tool/client/routes/types)
- [ ] Validate on real mobile cellular networks (iOS Safari + Android Chrome)
- [ ] Progressively enable `VITE_BROWSER_TOOL_ENABLED` after latency/error checks

**Sandbox:** Modal (serverless containers) provides a persistent Linux environment per session. The repo is cloned into `/workspace`. The Coder reads/writes files, runs commands, and gets diffs — all via sandbox tools. The Cloudflare Worker proxies sandbox requests to Modal web endpoints (keeps Modal auth server-side). Containers auto-terminate after 30 min.

**Coder delegation:** The Orchestrator can delegate coding tasks to the Coder via `delegate_coder`. The Coder runs autonomously with its own tool loop in the sandbox (unbounded rounds, 90s timeout per round, 60KB context cap), then returns a summary + cards to the Orchestrator.

**Auditor gate:** Every `sandbox_commit` runs through the Auditor first. The Auditor reviews the diff and returns a binary verdict (SAFE/UNSAFE). UNSAFE blocks the commit. The Auditor defaults to UNSAFE on any error (fail-safe).

**Repo hard lock:** The Orchestrator only sees the active repo in its context. Other repos are stripped entirely. Repo switching is UI-only via the header dropdown.

**Scratchpad:** A shared notepad that both the user and the LLM can read/write. User opens via button in ChatInput, the LLM updates via `set_scratchpad` / `append_scratchpad` tools. Content persists in localStorage and is always injected into the system prompt. Useful for consolidating ideas, requirements, and decisions throughout a session. Content is escaped to prevent prompt injection.

**Rolling window:** Context is managed by token budget, not fixed message count. The app summarizes older tool-heavy messages first, then trims oldest message pairs if still over budget, while keeping tool call/result pairs together.

**Project instructions (two-phase loading):** When the user selects a repo, the app immediately fetches `AGENTS.md` (or `CLAUDE.md` as fallback) via the GitHub REST API and injects it into the Orchestrator's system prompt and the Coder's context. When a sandbox becomes ready later, the app re-reads from the sandbox filesystem (which may have local edits) and upgrades the content. This ensures all agents have project context from the first message, not just after sandbox spin-up.

## Project Layout

```
app/src/
  components/chat/   # Chat UI (ChatContainer, ChatInput, MessageBubble, ScratchpadDrawer, etc.)
  components/cards/  # Rich inline cards (PRCard, SandboxCard, DiffPreviewCard, AuditVerdictCard, etc.)
  components/ui/     # shadcn/ui component library
  hooks/             # React hooks (useChat, useGitHubAuth, useRepos, useActiveRepo, useSandbox, useScratchpad, etc.)
  lib/               # Orchestrator, tool protocol, sandbox client, agent modules, workspace context
  sections/          # Screen components (OnboardingScreen, RepoPicker, FileBrowser)
  types/             # TypeScript type definitions
  App.tsx            # Root component, screen state machine
app/worker.ts        # Cloudflare Worker — streaming proxy to Kimi/Ollama/Mistral + sandbox proxy to Modal
sandbox/app.py       # Modal Python App — sandbox web endpoints (file ops, exec/git, browser tools)
sandbox/requirements.txt
wrangler.jsonc       # Cloudflare Workers config (repo root)
```

## Key Files

- `lib/orchestrator.ts` — System prompt, multi-backend streaming (Kimi + Ollama + Mistral SSE), think-token parsing, provider routing, token-budget context management
- `lib/github-tools.ts` — GitHub tool protocol (prompt-engineered function calling via JSON blocks), `delegate_coder`, `fetchProjectInstructions` (reads AGENTS.md/CLAUDE.md from repos via API)
- `lib/sandbox-tools.ts` — Sandbox tool definitions, detection, execution, `SANDBOX_TOOL_PROTOCOL` prompt
- `lib/sandbox-client.ts` — HTTP client for `/api/sandbox/*` endpoints (thin fetch wrappers)
- `lib/scratchpad-tools.ts` — Scratchpad tool definitions (`set_scratchpad`, `append_scratchpad`), prompt injection escaping
- `lib/tool-dispatch.ts` — Unified tool dispatch (GitHub + Sandbox + Scratchpad + delegation)
- `lib/coder-agent.ts` — Coder sub-agent loop (unbounded rounds, 90s timeout per round, uses active backend)
- `lib/auditor-agent.ts` — Auditor review + verdict (fail-safe to UNSAFE, uses active backend)
- `lib/workspace-context.ts` — Builds active repo context for system prompt injection
- `lib/providers.ts` — AI provider configs (Kimi + Ollama + Mistral), role-to-model mapping, backend preference
- `hooks/useChat.ts` — Chat state, message history, unified tool execution loop, Coder delegation, scratchpad integration
- `hooks/useSandbox.ts` — Sandbox session lifecycle (idle → creating → ready → error)
- `hooks/useScratchpad.ts` — Shared notepad state, localStorage persistence, content size limits
- `hooks/useGitHubAuth.ts` — PAT validation, OAuth flow, mount re-validation
- `hooks/useActiveRepo.ts` — Active repo selection + localStorage persistence
- `hooks/useRepos.ts` — Repo list fetching, sync tracking, activity detection
- `hooks/useMoonshotKey.ts` — Kimi For Coding API key management (localStorage + env fallback)
- `hooks/useOllamaConfig.ts` — Ollama Cloud API key + model name management (localStorage + env fallback)
- `hooks/useMistralConfig.ts` — Mistral Vibe API key + model name management (localStorage + env fallback)
- `types/index.ts` — All shared TypeScript types (includes card data types for sandbox, diff preview, audit verdict)

## Environment Variables

```env
VITE_MOONSHOT_API_KEY=...         # Optional — Kimi key, can also be set via Settings UI (sk-kimi-...)
VITE_OLLAMA_API_KEY=...           # Optional — Ollama Cloud key, can also be set via Settings UI
VITE_MISTRAL_API_KEY=...          # Optional — Mistral key, can also be set via Settings UI
VITE_GITHUB_TOKEN=...             # Optional, higher GitHub rate limits
VITE_GITHUB_CLIENT_ID=...         # Optional, enables OAuth login
VITE_GITHUB_OAUTH_PROXY=...       # Optional, required for OAuth token exchange
VITE_BROWSER_TOOL_ENABLED=true    # Optional, enables browser tools in prompts
VITE_API_PROXY_TARGET=...         # Optional, Vite /api proxy target (defaults to http://127.0.0.1:8787)
```

**Worker secrets (Cloudflare):**
- `MOONSHOT_API_KEY` — Kimi For Coding API key (production proxy, starts with `sk-kimi-`)
- `OLLAMA_API_KEY` — Ollama Cloud API key (production proxy)
- `MISTRAL_API_KEY` — Mistral Vibe API key (production proxy)
- `MODAL_SANDBOX_BASE_URL` — Modal app base URL (e.g. `https://youruser--push-sandbox`). Endpoints follow pattern `{base}-{function}.modal.run`
- `BROWSERBASE_API_KEY` — Browserbase API key (for browser screenshot/extract endpoints)
- `BROWSERBASE_PROJECT_ID` — Browserbase project id

**API keys:** Kimi, Ollama Cloud, and Mistral keys can be set via env vars or pasted in the Settings UI at runtime (stored in localStorage). Settings UI keys override env vars. When 2+ are set, the user picks which backend to use via a toggle in Settings. The preference is stored in localStorage.

**Production:** Cloudflare Worker at `app/worker.ts` holds `MOONSHOT_API_KEY`, `OLLAMA_API_KEY`, `MISTRAL_API_KEY`, and `MODAL_SANDBOX_BASE_URL` as runtime secrets. The client never sees them. The worker proxies `/api/kimi/chat` to `api.kimi.com` (with `User-Agent: claude-code/1.0.0` for Kimi's agent gating), `/api/ollama/chat` to `ollama.com/v1/chat/completions`, and `/api/mistral/chat` to `api.mistral.ai/v1/chat/completions`.

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
