Diff — Mobile AI Coding Agent

Purpose: ChatGPT with direct access to your repos. A personal, mobile‑first chat interface backed by role‑based AI agents that can read your code, write patches, run them in a sandbox, and commit to main — all from your phone.

This replaces the 3‑4 app juggle (GitHub mobile, Claude, Codex, GitSync) with a single conversation.

This roadmap assumes a role‑based architecture. Models are replaceable. Roles are locked.

All AI runs through Ollama Cloud (flat subscription, no token counting, no metering UI).

Orchestrator (Kimi K2.5) — Lead analyst, interprets conversation, coordinates specialists
Coder (GLM 4.7) — Writes, edits, and executes code in a sandbox
Auditor (Gemini 3 Pro) — Pre‑commit gate, risk review, binary verdict

The mobile experience is the primary constraint. Desktop parity is optional.


---

Design Principles (Non‑Negotiable)

1. Mobile First, Not Mobile Friendly — The app must feel natural on a phone. Desktop is secondary.

2. One App, Not Four — If you have to open GitHub, GitSync, or a separate AI app to finish the job, the app has failed.

3. Chat is the Interface — Conversation is the primary input. Everything you can do in the app, you can do by talking to it. No forms unless a form is genuinely faster.

4. Live Pipeline — Every action the system takes is visible in real time. Agent steps stream into the chat as they happen, Manus‑style. You watch the work unfold.

5. Write‑First Mobile — The phone is not read‑only. You can describe edits, review diffs, and commit to main from mobile. The Auditor earns trust, not access restrictions.

6. Quiet Confidence — Fewer words. Structured output. Clear uncertainty labeling. The agent does not explain itself unless asked.

7. Show, Don't Dump — Rich inline cards (repo status, diff previews, audit verdicts) appear in the chat instead of walls of text. One card per concern.


---

Agent Roles (Locked)

All agents run on Ollama Cloud models. Roles are locked. Models can be swapped as the catalog evolves. The user never picks a model — the Orchestrator routes to the right specialist automatically.

Current Model Assignments:
- Orchestrator → Kimi K2.5 (256K context, agent swarm decomposition)
- Coder → GLM 4.7 (198K context, SWE‑bench leader, agentic coding)
- Auditor → Gemini 3 Pro Preview (1M context, SOTA reasoning)


---

Orchestrator (Lead)

Role: Conversational lead and multi‑step coordinator. Every user message goes through the Orchestrator first. It has the most responsibility — it interprets intent, routes to specialists, and assembles results.

Responsibilities:
- Interpret natural language intent from the chat ("what changed today?", "fix the typo in config.ts")
- Decide which specialist(s) to invoke and what context they need
- Break complex requests into sequenced steps
- Assemble final outputs from specialist results
- Maintain conversation context and memory across turns
- Surface structured cards (repo status, diffs, verdicts) inline in the chat
- Sequence multi‑step workflows (edit → sandbox → audit → commit → CI)

Constraints:
- No direct code writing (Coder handles that)
- No risk assessment (Auditor handles that)
- No code execution

The Orchestrator is the voice of the app. Every response the user sees is shaped by Kimi.


---

Coder

Role: Code implementation and execution engine.

Responsibilities:
- Read files from repos via GitHub API
- Write and edit code in a sandbox environment
- Run code (lint, test, execute) to verify changes before committing
- Generate patches and multi‑file diffs
- Apply changes via GitHub API when approved

Constraints:
- No decision‑making authority — only acts when the Orchestrator delegates
- No self‑review — the Auditor evaluates all changes
- No direct conversation with the user — speaks through the Orchestrator
- Must verify changes in sandbox before proposing commits

Rule: The Coder generates and tests patches. It does not decide what patches mean or whether they ship.


---

Auditor

Role: Risk specialist and pre‑commit gate.

Responsibilities:
- Review all code changes before they hit main
- Identify security vulnerabilities, breaking changes, and regressions
- Provide binary verdict: "safe to push" or "review this first"
- Produce detailed risk items with severity levels
- Validate that sandbox test results match expectations

Constraints:
- No questions, no feature suggestions, no conversation
- No code writing
- Hardcoded evaluation prompts only
- Cannot be bypassed — every commit goes through audit

The Auditor is the reason you can commit to main from your phone without anxiety. It never initiates work. It evaluates artifacts produced by others.


---

Sandbox Architecture

The Coder needs an environment to read, write, and execute code — not just generate patches blind.

Options under consideration:
- WebContainers (Stackblitz) — Runs Node.js in the browser via WASM. Works on mobile. No server needed. Limited to Node/JS ecosystem.
- Remote containers — Spin up a Docker/Firecracker instance per session. Supports any language. Requires server infra.
- GitHub Codespaces API — Leverage GitHub's existing sandbox. Already has repo context. Costs per hour.

Decision criteria:
- Must work on mobile (rules out anything requiring a desktop IDE)
- Must support the user's primary languages
- Latency must be acceptable for conversational flow (seconds, not minutes)
- Prefer no additional infra if possible

The sandbox is not a full IDE. It is a verification layer — the Coder writes code, runs it, confirms it works, then proposes the commit.


---

Roadmap

Phase 0 — Foundation (Done)

Goal: Working mobile web app with basic GitHub integration and demo mode.

What shipped:
- Mobile‑first PWA with dark theme, installable to home screen (manifest + icons, SW defined but not registered)
- GitHub PAT authentication with validation (OAuth env vars exist but no OAuth flow)
- Onboarding gate: PAT entry screen → repo picker → chat (state machine in App.tsx)
- Repo picker with search, activity indicators, language tags, and sync
- Demo mode with mock repos when no PAT is set
- Role‑based model config in providers.ts (Orchestrator, Coder, Auditor defined — only Orchestrator wired up)
- Cloudflare Worker streaming proxy (app/worker.ts) with rate limiting, origin validation, and API key isolation

What was learned:
- The original form‑driven PR analysis UI felt mechanical, not conversational — replaced entirely in Phase 1
- Silent error fallbacks hide real problems — errors must surface in the UI
- Model selection should be automatic, not user‑facing
- Coder and Auditor roles should stay defined but dormant until their phases arrive


---

Phase 1 — Chat Interface (Done)

Goal: Replace the form‑driven home screen with a conversational interface. The chat becomes the primary way to interact with the app.

What shipped:
- Chat message list with auto‑scroll (ChatContainer)
- Mobile‑optimized text input, sticky bottom, Enter to send, Shift+Enter for newlines (ChatInput)
- Streaming responses from Ollama Cloud via Kimi K2.5, token‑by‑token display
- Think‑token parsing: Kimi's <think> blocks rendered as collapsible "Reasoning" sections in the UI
- Multi‑chat management: create, switch, delete conversations — all persisted in localStorage
- Rich inline cards for structured output (PR, PR list, commit list, file, branch list)
- Real‑time agent status bar ("Thinking…", "Responding…", "Fetching from GitHub…")
- Tool execution loop: detect JSON tool blocks in LLM response → execute → inject result → re‑call (up to 3 rounds)
- Tool result injection protection: results wrapped in [TOOL_RESULT] markers to prevent prompt injection
- Markdown‑lite formatting in messages: bold, inline code, fenced code blocks
- Empty state with contextual suggestions based on active repo
- Demo welcome message with simulated streaming when no API key is set

What this replaced:
- The form‑driven PR analysis flow (form → loading → results) — fully removed
- The "Analyze PR" button workflow — now you just ask in chat

What was learned:
- Ollama Cloud has no native function calling — prompt‑engineered tool protocol works, but the LLM occasionally emits malformed JSON. Retry logic (3 rounds max) catches most cases.
- Think tokens from Kimi K2.5 are surprisingly useful for transparency — users can see the reasoning before the answer. Worth keeping visible.
- Multi‑chat was needed earlier than expected — single‑conversation gets cluttered fast on mobile.


---

Phase 2 — Repo Awareness via Chat (Done)

Goal: Full GitHub repo context available through conversation. Ask anything about your repos and get structured answers.

What shipped:
- 5 GitHub tools via prompt‑engineered JSON protocol (no native function calling):
  - fetch_pr — full PR details with diff, files, status → PRCard
  - list_prs — paginated PR list with filters → PRListCard
  - list_commits — recent commits with SHA, message, author → CommitListCard
  - read_file — file contents with language detection + directory listing → FileCard
  - list_branches — branches with default/protected markers → BranchListCard
- Workspace context injection: system prompt includes active repo details (language, PR count, commit activity, push time)
- Repo hard‑lock: Orchestrator's context only contains the selected repo. Other repos are stripped entirely. Tools enforce access control via normalized repo matching.
- Repo‑scoped conversations: each chat is stamped with repoFullName. Switching repos filters to that repo's chats. Migration stamps existing unscoped chats on first load.
- Combined repo + chat selector dropdown (RepoAndChatSelector): trigger shows "repo / chat ▾", repo clicks stay open to re‑filter, chat clicks close.
- Scoped "delete all chats" — only wipes chats for the active repo, preserves other repos' history.
- Auto‑create: switching to a repo with no chats automatically creates a new one.

What was learned:
- "Cross‑repo context (switch mid‑conversation)" from the original plan was the wrong model. Repo‑scoped conversations (separate chat histories per repo) turned out to be more natural — you don't want Kimi confused about which repo you're asking about.
- The tool protocol works well for read‑only GitHub queries but will need rethinking for write operations (Phase 4). JSON block detection is fragile when the LLM decides to explain the JSON before emitting it.
- Workspace context injection (~1‑2KB) is cheap enough to include on every request. The repo hard‑lock keeps Kimi focused and prevents hallucinated cross‑repo references.


---

Phase 3 — Sandbox + Code Execution

Goal: Give the Coder a real environment to write and test code before proposing changes.

Features:
- Sandbox provisioning (WebContainers or remote container)
- Coder can clone repo, install dependencies, read/write files
- Coder can run commands (lint, test, build) and report results
- Sandbox state visible in the chat (live pipeline)
- Sandbox results feed into Auditor review
- Cleanup after session ends

Agent Use:
- Orchestrator delegates coding tasks to Coder with sandbox access
- Coder executes in sandbox, returns results to Orchestrator
- Orchestrator surfaces sandbox output as inline cards

Exit Criteria:
- The Coder can verify its own changes before proposing them
- You can see what the Coder ran and what happened
- Failed tests prevent bad commits


---

Phase 4 — Agent‑Assisted Coding

Goal: Describe what you want in plain language. The Coder does it in the sandbox. The Auditor reviews it. You confirm. It ships.

Features:
- Natural language code requests ("add a loading spinner to the dashboard")
- Coder generates changes in sandbox, runs tests
- Auditor reviews the diff with verdict card
- Diff preview card with accept / reject buttons
- Multi‑file change support
- Commit message drafted by Orchestrator, you approve
- Live pipeline shows every step as it happens in the chat

Workflow:
1. You describe the change in chat
2. Orchestrator interprets, routes to Coder with context
3. Coder generates changes in sandbox
4. Coder runs tests/lint in sandbox
5. Auditor reviews the diff → verdict card
6. You see diff preview + verdict in chat
7. Tap "Push" → commit lands on main
8. CI status streams into chat

Agent Use:
- Full pipeline: Orchestrator → Coder (sandbox) → Auditor → commit

Exit Criteria:
- You stop opening Claude or Codex for code changes
- A described change can go from English to main in under 2 minutes
- The Auditor catches obvious mistakes before they ship


---

Phase 5 — Extensions (Future)

Goal: Room for 1‑2 additional integrations discovered through real usage.

Candidates (not committed):
- CI/CD deeper integration (trigger deploys, view logs in chat)
- Issue/project tracking awareness ("what issues are assigned to me?")
- Voice input for hands‑free mobile use
- Multi‑turn memory (remember project context across sessions)
- Notifications and alerts in chat

Constraints:
- Max 2 extensions at a time
- Each must replace an external app, not add novelty
- If it doesn't reduce app‑juggling, it doesn't ship


---

Explicitly Skipped (Without Guilt)

- Per‑token billing or metering UI (Ollama Cloud subscription covers it)
- Full IDE replacement (this is a conversational agent, not VS Code mobile)
- Multi‑agent debate loops (agents have roles, not opinions)
- Continuous background monitoring (explicit user‑initiated actions only)
- Team collaboration features (this is a personal tool)
- Desktop‑first features (desktop is secondary, always)
- Form‑heavy UI (chat is the primary input — forms only where genuinely faster)


---

Success Definition

This app is successful if:

- You open it like you open ChatGPT — casually, on your phone
- You can say "fix the typo in README.md and push it" and it happens
- You see every step the agents take in real time
- The Auditor makes you trust commits from mobile
- It replaces GitHub mobile, Claude app, Codex website, and GitSync
- It saves time without demanding attention

If it ever feels like a dashboard instead of a conversation, it has gone wrong.
