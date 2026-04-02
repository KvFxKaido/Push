# Sandbox Mode (v1 Spec)

*Explore freely. Nothing is committed unless you choose.*

## Product Intent

Sandbox Mode is an ephemeral, consequence-light workspace for brainstorming and prototyping.
It lets users think by doing:

- talk through ideas
- create and edit files
- run commands in a real container
- shape a rough repo outline

The user can then choose what happens next:

- keep exploring
- download files

Nothing is promoted automatically. GitHub is not involved in v1.

---

## Core Decisions (v1)

1. Sandbox Mode uses a real Modal container and writable filesystem.
2. Sandbox Mode is not connected to a GitHub repo.
3. GitHub tools are not available in sandbox mode.
4. Session data is ephemeral and expires with sandbox lifecycle.
5. Sandbox Mode is the primary onboarding experience — no GitHub auth required to start.
6. The only export path is zip download. In-app repo creation is deferred to v2.

---

## Entry Points

Sandbox Mode has two entry points, serving different user states.

### 1) Onboarding Screen (unauthenticated — v1 priority)

New users see a prominent "Try it now" action on the onboarding screen, before any GitHub connection.
This is the primary v1 entry point.

Selecting it:

1. skips GitHub auth entirely
2. starts a Modal sandbox session
3. ensures an empty workspace at `/workspace`
4. opens chat with sandbox tools enabled
5. shows a clear status label: `Sandbox — ephemeral, not connected to GitHub`

### 2) Repo Picker (authenticated)

For users already connected to GitHub, Sandbox Mode appears in the repo picker as a first-class option:

`New Sandbox`

Selecting it follows the same flow as above (steps 2-5).

---

## Allowed vs Blocked

### Allowed

- create, edit, rename, and delete files
- run code, scripts, and tests in sandbox
- ask agent to propose structure and scaffold rough files
- iterate on multiple approaches
- discard work with no side effects

### Blocked

- all GitHub API tools
- commit and push actions
- language implying permanence by default

The assistant should behave as a collaborative thinking partner, not an auto-ship agent.

---

## Session Lifecycle

- sandbox lifetime follows existing container policy (currently 30 minutes)
- a visible countdown or warning is shown when ~5 minutes remain
- if expired, workspace contents are lost — the user is informed clearly and can start a new sandbox
- no implicit persistence to GitHub or anywhere else

Known limitation: 30-minute lifetime may frustrate longer prototyping sessions. This is a Modal container policy constraint. Mitigation options (post-v1): session extension, or periodic auto-snapshot to browser storage.

Optional future enhancement (not v1):

- restore last sandbox session if still alive and valid

---

## Export

Sandbox Mode has two user actions:

1. Keep Exploring
2. Download Files (.tar.gz)

There is no automatic next step.

### 1) Keep Exploring

- remain in current sandbox
- no state transition

### 2) Download Files (.tar.gz)

- downloads full `/workspace` contents minus temp artifacts (`.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`)
- archive is built server-side via `tar czf` with exclusions, base64-encoded, and sent to the client
- 100MB archive size limit enforced server-side
- sandbox can continue running after download
- three download affordances:
  - persistent download button in the sandbox header (always visible when sandbox is ready)
  - download button in the expiry warning banner (visible at ~5 min remaining)
  - AI-invocable `sandbox_download` tool (renders a download card in chat)

---

## UX Requirements

- persistent copy in UI:
  - "Nothing is committed unless you choose."
- clear mode badge in header:
  - "Sandbox"
- download action is visible but never forced
- no scary warnings, no fake urgency
- mobile-first flow with minimal steps

---

## Prompt/Agent Requirements

When in Sandbox Mode:

- assistant may use sandbox tools (file ops, exec, browser tools)
- assistant must not use GitHub tools
- assistant should surface assumptions and tradeoffs
- assistant should prefer tentative language for structure proposals
- system prompt omits workspace context (no active repo, no AGENTS.md, no file tree) — replaced with a sandbox-specific preamble that describes the ephemeral environment and available tools
- Coder `agentsMdRef` is empty; Coder operates with sandbox tools only
- Auditor is not invoked (no commits to audit)

Examples:

- good: "Here is a rough structure we can try."
- bad: "I created your repo and pushed this."

---

## Non-Goals (v1)

- in-app GitHub repo creation (latency and sync concerns make this a poor first experience)
- automatic repo creation, commits, or push
- hidden persistence semantics
- heavy templates or opinionated starters
- multiple parallel sandbox sessions
- telemetry (no analytics infrastructure exists yet — revisit when a provider is chosen)

---

## Future Considerations (post-v1)

- **Create Repo from Sandbox** — in-app promotion to GitHub repo (requires solving upload latency, sandbox-to-repo state transition, and new sandbox spin-up with cloned repo)
- starter templates (e.g. "React app", "Python CLI") as optional scaffolds
- session restore if sandbox is still alive
- sandbox lifetime extension or auto-snapshot
- telemetry for sandbox usage patterns
- multiple parallel sandbox drafts

---

## Implementation Notes (v1)

Status: **implemented** (2026-02-09)

### Files changed

| Layer | File | What |
|---|---|---|
| Backend | `sandbox/app.py` | `create()` supports empty repo; new `create_archive()` endpoint |
| Worker | `app/worker.ts` | `download: 'create-archive'` route |
| Client | `app/src/lib/sandbox-client.ts` | `downloadFromSandbox()` function |
| Tools | `app/src/lib/sandbox-tools.ts` | `sandbox_download` tool (detect/validate/execute) |
| Types | `app/src/types/index.ts` | `SandboxDownloadCardData`, `ChatCard` union member |
| State | `app/src/hooks/useSandbox.ts` | Supports `''` as ephemeral repo; exports `createdAt` |
| Prompt | `app/src/lib/orchestrator.ts` | Sandbox-specific preamble (no GitHub tools) |
| App | `app/src/App.tsx` | `isSandboxMode` flag, entry points, header badge, download button, expiry banner |
| Entry | `app/src/sections/OnboardingScreen.tsx` | "Try it now" button |
| Entry | `app/src/sections/RepoPicker.tsx` | "New Sandbox" card |
| Card | `app/src/components/cards/SandboxDownloadCard.tsx` | Download card UI (new file) |
| Card | `app/src/components/cards/CardRenderer.tsx` | `sandbox-download` case |
| Banner | `app/src/components/chat/SandboxExpiryBanner.tsx` | Countdown + download + restart (new file) |

### Deviations from original spec

- Export format is `.tar.gz`, not `.zip` — tar is native to the Linux sandbox and avoids adding zip tooling to the Modal image.
- Download is available via three affordances (header button, expiry banner, AI tool) instead of a single action.
- Expiry warning includes both a countdown timer and a one-click download button.

---

## Summary

Sandbox Mode is the place to think, test, and shape ideas with real execution but zero default commitment.
It doubles as the primary onboarding experience — new users can try Push without connecting GitHub.
When the user wants to keep their work, they download a tar.gz and take it to GitHub on their own terms.
