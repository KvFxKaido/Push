# Push — Copilot Context

Mobile-native AI coding agent with direct GitHub repo access. Chat with your codebase — review PRs, explore changes, and ship code from your phone.

## Development Workflow

### Build, Test, Lint

**Frontend (app/):**
```bash
cd app
npm install
npm run dev        # Development server
npm run build      # TypeScript + Vite build
npm run lint       # ESLint
npm test           # Run tests with vitest
npm run test:watch # Watch mode
```

**Cloudflare Worker:**
```bash
# From repo root
npx wrangler dev --port 8787  # Local worker dev server
npx wrangler deploy            # Deploy to production
```

**Modal Sandbox (sandbox/):**
```bash
cd sandbox
pip install -r requirements.txt
modal deploy app.py
```

### Local Development
- Frontend runs on Vite dev server (default: http://localhost:5173)
- `/api/*` routes proxy to local Worker at http://127.0.0.1:8787
- Override proxy target with `VITE_API_PROXY_TARGET` if needed
- API keys can be set in `app/.env` or via Settings UI at runtime

## Architecture

### Role-Based Agent System

Three distinct agent roles, all served by the user-selected AI backend:

| Role | Responsibility | Key Behavior |
|------|----------------|--------------|
| **Orchestrator** | Conversational lead, interprets intent, delegates tasks | Unbounded tool loop until task completion |
| **Coder** | Autonomous code implementation in sandbox | Unbounded rounds, 90s timeout per round, 60KB context cap |
| **Auditor** | Pre-commit safety gate | Binary SAFE/UNSAFE verdict, defaults to UNSAFE on error |

**Models are replaceable; roles are not.** The user picks a backend (Mistral, Ollama, Z.ai, MiniMax, or OpenRouter); all agents use it.

### Active Branch Model

There is always exactly **one Active Branch** per repo session:
- Commit target, push target, diff base, and chat context
- Switching branches **tears down the sandbox** and creates a fresh one (clean state)
- Chats are **permanently branch-scoped** and grouped by branch in history
- Branch creation via workspace/header action on main; feature branches show "Merge into main"

### Merge Flow (GitHub PR Only)

All merges go through GitHub — **Push never runs `git merge` locally**.

Five-step merge ritual:
1. Check for clean working tree (commit & push if dirty)
2. Find or create a Pull Request via GitHub API
3. Auditor reviews the PR diff (`main...active`) with SAFE/UNSAFE verdict
4. Check merge eligibility (mergeable state, CI, reviews)
5. Merge via GitHub API (merge commit strategy, no fast-forward)

PRs are **only created as part of this merge ritual** — no standalone "create PR" action.

### Tool Protocol

Tools are **prompt-engineered** — the system prompt defines available tools and JSON format.

Pattern:
1. Agent emits JSON tool blocks in response
2. Client detects via `detect*ToolCall()` functions
3. Client executes via `execute*ToolCall()` functions
4. Results injected as synthetic messages
5. LLM re-called with updated context

**Tool loops are unbounded** — they continue until the model stops emitting tool calls (or user aborts).

All tool dispatch is unified via `lib/tool-dispatch.ts`.

### Harness Reliability Focus

Current priorities from `documents/Harness Reliability Plan.md`:
- **Edit reliability** — Hashline experiment for line-tagged references (gated by provider compliance)
- **Read efficiency** — Range-aware file reads with line numbers, default caps
- **Tool-loop robustness** — Garbled tool-call recovery, per-provider compliance metrics
- **Background execution** — Server-run jobs for mobile lock/background resilience
- **Operator visibility** — Enhanced console/debug traces, metadata on all error paths

**Reliability is prioritized over model churn.** Small, reversible bets with measurement gates.

### Sandbox Architecture

- **Modal** (serverless containers) provides persistent Linux environment
- Repo cloned to `/workspace` (or empty workspace in Sandbox Mode)
- Container auto-terminates after 30 minutes
- Cloudflare Worker proxies sandbox requests to Modal (keeps Modal auth server-side)
- All sandbox tools prefixed `sandbox_*`

### Context Management (Rolling Window)

- **Token budget**, not fixed message count
- Summarizes older tool-heavy messages first
- Trims oldest message pairs if still over budget
- Preserves tool call/result pairs together

### Project Instructions (Two-Phase Loading)

When user selects a repo:
1. **Immediate:** Fetch `AGENTS.md` or `CLAUDE.md` via GitHub REST API
2. **On sandbox ready:** Re-read from sandbox filesystem (may have local edits)

This ensures all agents have project context from the first message.

## Code Organization

### Directory Layout

```
app/
├── src/
│   ├── components/
│   │   ├── chat/         # Chat UI components
│   │   ├── cards/        # Rich inline cards (PRCard, DiffPreviewCard, etc.)
│   │   ├── filebrowser/  # File browser UI
│   │   └── ui/           # shadcn/ui primitives
│   ├── hooks/            # React hooks for state/data fetching
│   ├── lib/              # Core logic, agents, tools, prompts
│   ├── sections/         # Screen-level components
│   └── types/index.ts    # All shared TypeScript types
├── worker.ts             # Cloudflare Worker (AI & sandbox proxy)
└── package.json
sandbox/
├── app.py                # Modal Python App (sandbox web endpoints)
└── requirements.txt
```

### Key Files

**Agent Modules:**
- `lib/orchestrator.ts` — SSE streaming, token-budget context, role routing
- `lib/coder-agent.ts` — Coder autonomous loop
- `lib/auditor-agent.ts` — Auditor safety gate (fail-safe to UNSAFE)

**Tool Protocol:**
- `lib/github-tools.ts` — GitHub API tools, branch/PR/merge operations
- `lib/sandbox-tools.ts` — Sandbox tool definitions
- `lib/scratchpad-tools.ts` — Shared notepad tools
- `lib/tool-dispatch.ts` — Unified tool dispatch layer
- `lib/web-search-tools.ts` — Web search (Tavily, Ollama native, DuckDuckGo)

**Core Utilities:**
- `lib/workspace-context.ts` — Active repo context builder
- `lib/providers.ts` — AI provider configs, role-to-model mapping
- `lib/prompts.ts` — Prompt building utilities
- `lib/feature-flags.ts` — Feature flag system
- `lib/snapshot-manager.ts` — Workspace snapshot/recovery

**State Management:**
- `hooks/useChat.ts` — Chat state, message history, tool execution loop
- `hooks/useSandbox.ts` — Sandbox session lifecycle
- `hooks/useScratchpad.ts` — Shared notepad state
- `hooks/useUserProfile.ts` — User identity (name, bio, GitHub login)
- `hooks/useProtectMain.ts` — Main branch protection settings
- `types/index.ts` — All TypeScript types (discriminated unions for cards)

## Coding Conventions

### TypeScript
- **Strict mode** — explicit return types on exported functions
- **Types centralized** in `types/index.ts`
- **Discriminated unions** for card types (with `type` discriminator field)

### React
- **Functional components** with custom hooks
- **Hooks pattern:** `use` prefix, encapsulate all data fetching/state for a concern
- **PascalCase** for components, **camelCase** for functions/variables

### Styling
- **Tailwind CSS** + **shadcn/ui** (Radix primitives)
- Use `cn()` helper for class merging (from `lib/utils.ts`)
- Mobile-first responsive design

### File Placement
- Screen-level components → `sections/`
- Chat UI → `components/chat/`
- Inline cards → `components/cards/`
- File browser → `components/filebrowser/`
- Agent modules → `lib/`, export single `run*()` function
- Hooks → `hooks/`, encapsulate state/data for specific concerns

### Tool Pattern
Follow the detect → execute pattern:
1. `detect*ToolCall(content: string)` — Parse JSON tool block from LLM output
2. `execute*ToolCall(...)` — Execute the tool and return result
3. Unified via `lib/tool-dispatch.ts`

## Design Principles

1. **Mobile first, not mobile friendly** — Built for phones first
2. **One app, not four** — If you leave the app to finish, it failed
3. **Chat is the interface** — Conversation is primary input
4. **Live pipeline** — Every agent step visible in real time
5. **Write-first mobile** — Auditor earns trust, not access restrictions
6. **Quiet confidence** — Fewer words, structured output
7. **Show, don't dump** — Rich inline cards over text walls

## Security & Boundaries

### Hard Constraints
- **Repo hard lock** — Orchestrator only sees active repo (other repos stripped)
- **Active branch context** — Single branch per session (switching tears down sandbox)
- **Auditor gate** — Cannot be bypassed; every commit requires SAFE verdict
- **Auditor fail-safe** — Defaults to UNSAFE on any error
- **Branch-scoped chats** — Permanently bound to creation branch, never duplicated/rebound
- **GitHub-only merges** — No local `git merge`, all merges via GitHub PR API

### API Keys & Secrets
- In production: Worker proxies all AI calls, API keys stored as Worker secrets
- In development: Keys in `app/.env` or Settings UI
- Never exposed to client in production

### Sandbox
- 30-minute container lifetime with auto-termination
- Modal auth stays server-side (Worker proxy)
- Browser tools validate URL shape/protocol, reject private-network targets

### Scratchpad
- Content escaped to prevent prompt injection
- Capped at 50KB

## Common Tasks

### Adding a New Card Type
1. Define type in `types/index.ts` with discriminated union
2. Create component in `components/cards/`
3. Add to `CardRenderer.tsx`
4. Emit from tool execution in `lib/*-tools.ts`

### Adding a New Tool
1. Define tool schema in `lib/*-tools.ts`
2. Add to tool protocol prompt constant
3. Implement `detect*ToolCall()` function
4. Implement `execute*ToolCall()` function
5. Add to `lib/tool-dispatch.ts`

### Adding a New Agent
1. Create module in `lib/*-agent.ts`
2. Export single `run*()` function
3. Add role to `lib/providers.ts` role-to-model mapping
4. Wire up in `lib/orchestrator.ts` or delegation flow

### Modifying System Prompts
- Orchestrator prompt: `lib/orchestrator.ts`
- Coder prompt: `lib/coder-agent.ts`
- Auditor prompt: `lib/auditor-agent.ts`
- Tool protocol prompts: `lib/*-tools.ts` constants

### Feature Flags
- Add to `lib/feature-flags.ts`
- Check via `useFeatureFlags()` hook or direct import
- Environment-gated flags use `VITE_*` prefix

## Testing

**Run all tests:**
```bash
cd app
npm test
```

**Watch mode:**
```bash
npm run test:watch
```

## CI/CD

**GitHub Actions workflows:**
- `.github/workflows/ci.yml` — Lint, test, build on push/PR to main
- `.github/workflows/deploy-modal.yml` — Deploy Modal sandbox on push to main

**Manual deployment:**
```bash
# Deploy frontend + worker
cd app && npm run build
npx wrangler deploy  # from repo root

# Deploy sandbox
cd sandbox
modal deploy app.py
```

## Environment Variables

Key variables (all optional, app runs in demo mode without them):

```env
# AI Providers (user picks in Settings)
VITE_MISTRAL_API_KEY=...     # Mistral Vibe
VITE_OLLAMA_API_KEY=...      # Ollama Cloud
VITE_ZAI_API_KEY=...         # Z.ai
VITE_MINIMAX_API_KEY=...     # MiniMax

# Optional Features
VITE_TAVILY_API_KEY=...      # Web search (premium)
VITE_BROWSER_TOOL_ENABLED=true  # Browser tools

# GitHub Auth
VITE_GITHUB_TOKEN=...        # PAT for API access
VITE_GITHUB_CLIENT_ID=...    # GitHub App OAuth
```

## Additional Context

- **Sandbox Mode** — Ephemeral workspace with no GitHub repo, 30-min lifetime
- **Scratchpad** — Shared notepad for user + AI, persisted in localStorage
- **User Identity** — Display name, bio, GitHub login set in Settings, injected into prompts
- **Protect Main** — Optional setting to block direct commits to `main`
- **PR Awareness** — Home screen shows open PR count and review-requested indicator

For full architectural details, see `AGENTS.md` and `CLAUDE.md`.
