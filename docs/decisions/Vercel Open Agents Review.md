# Vercel Open Agents Review

**Date:** 2026-04-14
**Source:** [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) (MIT)
**Companion site:** [open-agents.dev](https://open-agents.dev)
**Status:** Comparative research reference. Informs the priority list at the bottom, with **Modal sandbox snapshots** flagged as the headline adoption target.

---

## 1. What Open Agents is

Open Agents is Vercel's open-source reference implementation of a cloud coding agent — the same shape as Push, just on Vercel's stack. It is a Turborepo monorepo:

```
apps/web              Next.js app, workflows, auth, chat UI
packages/agent        Agent runtime, tools, subagents, skills
packages/sandbox      Sandbox abstraction + Vercel Sandbox integration
packages/shared       Shared utilities
```

The architecture is the same three-layer "Web → Agent workflow → Sandbox VM" topology Push uses, with the agent running **outside** the sandbox and interacting with it through tool calls. We are not architecturally behind them — most of what they ship, we have an analog for.

## 2. Stack at a glance

| Layer | Open Agents | Push |
|---|---|---|
| Web | Next.js | React 19 + Vite |
| Runtime | Vercel Workflow SDK (durable) | Cloudflare Worker (streaming proxy) + client-side journal |
| Sandbox | Vercel Sandboxes (snapshot + hibernation) | Modal containers (no snapshots today) |
| DB | Postgres (Neon) + Upstash KV | None server-side; localStorage + IndexedDB |
| Auth | Vercel OAuth + GitHub App | GitHub App + OAuth + PAT |
| Voice | ElevenLabs transcription | None |
| Sharing | Read-only public session links | None |
| Skills | Bundled in `packages/agent` | Filesystem `.md` skills (`cli/skill-loader.ts`) |
| Tool dispatch | Single chat-driven agent | Role split (Orchestrator/Explorer/Coder/Reviewer/Auditor) |
| CLI | None | Yes, sharing root `lib/` runtime |

## 3. Features Open Agents ships

| Feature | Summary |
|---|---|
| **Durable workflow runs** | Agent turns run as Vercel Workflows; survive client disconnect; streams reconnect to in-flight runs. |
| **Snapshot-based sandbox resume** | Vercel Sandboxes are snapshotted and hibernated; resume is fast and stateful, not "re-clone from git." |
| **Sandbox port exposure** | Ports 3000/5173/4321/8000 are forwarded out of the sandbox so users can preview running dev servers (Next, Vite, Astro, Python). |
| **Read-only session share links** | Any session can be shared via a public read-only URL. |
| **GitHub App install + OAuth user auth** | Standard GitHub App webhook flow plus per-user OAuth for repo access. |
| **Voice transcription** | ElevenLabs speech-to-text on the chat input. |
| **Auto commit/push/PR** | Preference-driven automation for the GitHub delivery loop. |
| **Skills (Vercel ecosystem)** | Companion ecosystem [skills.sh](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem) with `npx skills add` for installing skill packages. |

## 4. Overlap with Push today

Honest list of what we already cover. Don't reimplement these:

- **Agent-outside-sandbox topology** — Push agent runs in the Worker/CLI; Modal is dumb compute. Same shape.
- **Tool dispatch and registry** — `lib/tool-registry.ts` + `app/src/lib/tool-dispatch.ts` define ~40 tools shared across web and CLI. More unified than open-agents (we also feed a CLI; they don't).
- **Role split** — Orchestrator / Explorer / Coder / Reviewer / Auditor (`docs/architecture.md:25`). Open Agents has a single chat-driven agent; ours is more sophisticated.
- **GitHub App + OAuth + PAT** — `app/src/lib/github-auth.ts`, `app/src/hooks/useGitHubAppAuth.ts`. Token refresh, commit identity, PAT fallback all wired.
- **MCP** — `mcp/github-server/src/index.ts` exposes ~17 GitHub tools over stdio.
- **Skills (filesystem)** — `cli/skill-loader.ts` loads `.push/skills/` and `.claude/commands/` `.md` files at runtime; supports shadowing built-ins.
- **Resumable sessions** — `app/src/lib/run-journal.ts`, `app/src/lib/snapshot-manager.ts`, `cli/session-store.ts`, plus the design in `docs/decisions/Resumable Sessions Design.md`. Client-side checkpoints + git truth reconstruction.
- **Auditor pre-commit gate** — Open Agents has nothing equivalent.
- **Branch-scoped chats and Workspace Hub** — Open Agents has neither.

## 5. Genuine gaps worth adopting

### 5.1 Modal sandbox snapshots — primary target ⭐

**The headline adoption.** Push's resume strategy today is:

1. Modal container persists naturally up to ~30 minutes.
2. After that, recovery means re-cloning the repo and replaying state from the client journal + git truth (`Resumable Sessions Design.md`, `snapshot-manager.ts`).

This is correct but slow. "Reopen the chat 2 hours later" pays the full clone-and-warm cost every time. On mobile, where sessions are bursty and the user is constantly backgrounding, this is the dominant resume latency.

Modal supports memory snapshots and filesystem checkpoints. Adopting them would let us:

- Hibernate a sandbox after N minutes of idle instead of letting it die.
- Resume in seconds with the working tree, dev-server processes, installed deps, and shell history intact.
- Decouple resume from the client journal — the sandbox itself becomes the resume substrate, with the journal as a fallback.

**Open questions to answer in a follow-up design doc:**

- Modal snapshot lifecycle: what's the actual resume latency, snapshot size budget, and pricing impact per session?
- Where snapshots live in the runtime contract: is "hibernated" a new sandbox phase exposed to the agent via the session capability block in [`docs/architecture.md`'s sandbox/session architecture section](../architecture.md#sandbox-architecture)?
- Interaction with the existing `run-journal` checkpoint flow — is the journal still authoritative, or does the snapshot become the source of truth and the journal degrade to an audit log?
- Branch switching tears down the sandbox (`docs/architecture.md:62`). Should snapshots be keyed by `(repo, branch)` so per-branch resume is instant?
- Multi-tenant cleanup: TTL, eviction policy, and how we handle stale snapshots on Modal.
- CLI parity: snapshots are useless in the local CLI (the FS *is* the user's repo), so this is a web-only feature. Confirm the runtime contract still holds.

**Estimated impact:** very high. This is the single biggest UX improvement available without changing any model behavior.

### 5.2 Sandbox port exposure / dev-server previews ⭐

Today Push has zero port forwarding from Modal — the agent can write a Vite app but the user can't see it run. Open Agents exposes 3000/5173/4321/8000 by default and surfaces them as preview URLs.

For a mobile-first product this is a flagship feature: "tap to preview the dev server on your phone" turns Push from a code-editing agent into something that demos its own work. Mostly a `sandbox/` plumbing job (Modal supports tunneled web endpoints) plus a Workspace Hub tile.

**Estimated impact:** very high. Pairs naturally with snapshots (a hibernated sandbox can resume with the dev server already running).

### 5.3 Read-only session share links ⭐

Open Agents lets you share a session via a public read-only URL. Push has nothing — chats are device-local and auth-locked. For a mobile product this is both a growth vector ("look what the agent built") and a support tool ("here's what broke, look at the trace").

Requires server-side persistence of run journals (today: `run-journal.ts` in localStorage). Naturally couples with **5.4** below.

**Estimated impact:** high. Smallest feature with the largest visibility.

### 5.4 Server-side durable runs / stream reconnection

Open Agents uses Vercel Workflow SDK for durable multi-step turns; clients can reconnect to in-flight workflows mid-stream. Push relies entirely on **client-side** checkpoints, which is fragile on mobile Safari (aggressive tab eviction).

We can't adopt Workflow SDK directly (Vercel-locked), but the *pattern* maps onto Cloudflare Workflows / Durable Objects on the Worker we already run. Worth a separate design doc; this is a meaningful re-architecture, not a copy-paste.

**Estimated impact:** high but expensive. Sequence after **5.1** and **5.3**.

### 5.5 Voice input (ElevenLabs)

Trivial drop-in, big mobile UX win. Voice prompts while walking is the kind of thing that justifies "agent in your pocket." ~1 day of work.

**Estimated impact:** medium, but cheap.

### 5.6 skills.sh compatibility

Vercel introduced [skills.sh](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem) as an open registry/leaderboard for skill packages, installable via `npx skills add`. Our `cli/skill-loader.ts` already loads `.md` skills from `.push/skills/` and `.claude/commands/`. If skills.sh's package format is close enough to ours, supporting `npx skills add` against our directories gets us free ecosystem reach with very little code.

**Estimated impact:** medium. Worth a one-day spike to confirm format compatibility.

## 6. Not worth taking

- **Vercel Workflow SDK itself** — provider lock-in. Steal the pattern, not the SDK.
- **Next.js / Bun / Turborepo** — pure stack churn.
- **Their tool registry** — ours is more unified and shared with a CLI surface they don't have.
- **Their single-agent model** — our role split (Orchestrator/Explorer/Coder/Reviewer/Auditor) is strictly more sophisticated.
- **Their GitHub App flow** — we already have App + OAuth + PAT.
- **Postgres + Upstash** — only relevant if we adopt **5.3** / **5.4**, and we'd pick storage to match Cloudflare, not Vercel.

## 7. Recommended sequencing

1. **Modal sandbox snapshots design doc** (5.1). This is the user-flagged primary target. Unblocks fast resume and dovetails with port exposure.
2. **Sandbox port exposure** (5.2). High-impact, low-risk, complements snapshots directly.
3. **Read-only share links** (5.3). Forces the server-side persistence work that **5.4** also needs.
4. **Server-side durable runs on Cloudflare** (5.4). Larger re-architecture; sequence after we have server-side run state from **5.3**.
5. **Voice input** (5.5) and **skills.sh compatibility** (5.6) as cheap follow-ups whenever there's slack.

## 8. References

- [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents)
- [Open Agents Vercel template](https://vercel.com/templates/template/open-agents)
- [Modal Checkpoints](https://modal.com/docs/guide/checkpoints)
- Internal: `docs/decisions/Resumable Sessions Design.md`, `docs/architecture.md`, `app/src/lib/snapshot-manager.ts`, `app/src/lib/run-journal.ts`, `lib/tool-registry.ts`
- [Vercel Agentic Infrastructure](https://vercel.com/blog/agentic-infrastructure)
- Internal: `docs/decisions/Resumable Sessions Design.md`, `docs/architecture.md`, `app/src/lib/snapshot-manager.ts`, `app/src/lib/run-journal.ts`, `lib/tool-registry.ts`
