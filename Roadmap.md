Diff — Mobile GitHub Command Center

Purpose: A personal, mobile‑first app that replaces the 3‑4 app juggle (GitSync, GitHub, Claude, Codex) with one place to see your repos, make edits, commit to main, and watch the pipeline — all from your phone.

This roadmap assumes a role‑based architecture. Models are replaceable. Roles are sacred.

All AI runs through Ollama Cloud (flat subscription, no token counting, no metering UI).

Orchestrator — Routes intent, normalizes input, never does the work

Coder — Writes and edits code on your behalf

Auditor — Pre‑commit sanity check, risk review

Philosophy: Small, opinionated menus per role — not a single champion. Trade theoretical peak performance for psychological sustainability.

The mobile experience is the primary constraint. Desktop parity is optional.


---

Design Principles (Non‑Negotiable)

1. Mobile First, Not Mobile Friendly — The app must feel natural on a phone. Desktop is secondary.

2. One App, Not Four — If you have to open GitHub, GitSync, or a separate AI app to finish the job, the app has failed.

3. Live Pipeline — Every action the system takes is visible in real time. No spinners. No "please wait." You see each step as it happens, Manus‑style.

4. One Action Per Screen — Each screen does one thing well. No dense dashboards.

5. Quiet Confidence — Fewer words. Structured output. Clear uncertainty labeling.

6. Write‑First Mobile — The phone is not read‑only. You can edit, commit, and push from mobile. The app earns trust through the Auditor, not by withholding access.

7. No Chat by Default — Conversation exists only where it adds clarity, not everywhere.


---

Agent Roles (Locked)

All agents run on Ollama Cloud models. Specific model assignments will evolve as the Ollama Cloud catalog changes. The roles do not change.

Orchestrator

Role: Translate human intent into structured actions. Normalize ambiguity before routing.

Responsibilities:
- Interpret user intent ("edit this file", "commit to main", "check this PR")
- Normalize vague input into structured, actionable intents ("clean this up" → specific file + action)
- Decide which agent(s) to invoke
- Present results and step‑by‑step progress in the live feed
- Sequence multi‑step workflows (edit → audit → commit → watch CI)

Constraints:
- No direct repo access
- No code writing
- No analysis generation

The orchestrator should never surprise you. It routes the work, never does the work.


---

Coder

Role: Implementation and code manipulation — from mobile.

Responsibilities:
- Edit files via GitHub API (Contents API / commit creation)
- Generate patches and diffs
- Apply multi‑file changes when described by the user
- Explain code changes when requested

Constraints:
- No decision‑making authority
- No self‑review (Auditor handles that)
- No user conversation
- Only acts when explicitly summoned

Rule: Coders generate patches. They do not decide what patches mean.


---

Auditor

Role: Pre‑commit gate and analysis engine.

Responsibilities:
- Review changes before they hit main
- Identify risks, regressions, and breaking changes
- Classify logical vs mechanical changes
- Flag hotspots and complexity
- Provide binary verdict: "safe to push" or "review this first"

Constraints:
- No questions
- No feature suggestions
- No conversation
- Hardcoded prompts only

The Auditor is the reason you can write to main from mobile without anxiety. It never initiates work. It evaluates artifacts produced by others.


---

Roadmap

Phase 0 — Stabilization (Done / In Progress)

Goal: Solidify the existing mobile web app foundation.

- Mobile‑first layout locked
- Demo mode for zero‑auth usage
- Basic PR analysis with Ollama Cloud
- Collapsible result sections
- PWA installable to home screen

Exit Criteria:
- App usable one‑handed
- No horizontal scroll
- Analysis readable in under 2 minutes


---

Phase 1 — Repo Awareness & GitHub Auth

Goal: Replace GitSync and the GitHub mobile app for day‑to‑day repo monitoring.

Features:
- GitHub OAuth with read/write scopes
- Repo list with last‑sync timestamps
- Recent commits, open PRs, branch heads
- PR status overview (open / draft / merged)
- Commit history since last check
- Manual "Sync Now" (no background polling)
- Offline cache of repo metadata

Agent Use:
- Orchestrator summarizes "what changed since last check"

Exit Criteria:
- You stop opening GitSync
- You stop opening the GitHub app for status checks
- App is useful offline for recent state inspection


---

Phase 2 — Direct Edit & Commit

Goal: Edit files and commit directly to main from your phone.

Features:
- File browser (navigate repo tree via GitHub API)
- File viewer with edit mode (plain textarea for quick copy‑paste edits, not a code editor)
- Single‑file and multi‑file commits to main
- Commit message generation (Orchestrator drafts, you approve)
- Pre‑commit Auditor review with binary verdict
- Diff preview before pushing

Workflow:
1. Navigate to file
2. View file contents, tap edit for quick changes (copy‑paste, fix a string, update config)
3. Auditor reviews the diff automatically
4. You see verdict: "safe to push" or flagged risks
5. Confirm → commit lands on main

Agent Use:
- Coder applies edits when you describe what you want
- Auditor gates every commit with a sanity check
- Orchestrator sequences the workflow and drafts commit messages

Exit Criteria:
- You can make a real edit to main and know it landed — without leaving the app
- Auditor catches obvious mistakes before they ship


---

Phase 3 — Live Pipeline Feed

Goal: Manus‑style real‑time visibility into every action the app takes.

Features:
- Step‑by‑step activity log for every operation
- Live status: "Fetching file…" → "Editing…" → "Auditor reviewing…" → "Committing…" → "CI running…" → "Checks passed ✓"
- GitHub Actions / CI status polling after commit
- Expandable detail on each step (see the actual diff, the audit result, the CI output)
- Push notifications for CI completion (optional)

Agent Use:
- Orchestrator emits structured events as it sequences work
- All agent outputs stream into the feed

Exit Criteria:
- You never wonder "did it work?"
- The app shows you exactly what happened, when, and whether it succeeded


---

Phase 4 — Agent‑Assisted Edits

Goal: Describe what you want changed in plain language. The Coder does it. The Auditor checks it. You confirm.

Features:
- Natural language intent input ("add a loading spinner to the dashboard component")
- Coder generates the patch
- Auditor reviews the patch
- Diff preview with accept / reject
- Multi‑file change support
- Live feed shows every agent step

Workflow:
1. You describe the change
2. Orchestrator normalizes your request and routes to Coder
3. Coder generates patch
4. Auditor reviews
5. You see the diff + verdict in the live feed
6. Confirm → commit to main

Agent Use:
- Full pipeline: Orchestrator → Coder → Auditor

Exit Criteria:
- You stop opening Claude or Codex in separate apps for code changes
- Complex edits happen entirely within Diff


---

Phase 5 — Extensions (Future)

Goal: Room for 1‑2 additional integrations discovered through real usage.

Candidates (not committed):
- CI/CD deeper integration (trigger deploys, view logs)
- Issue/project tracking awareness
- Notifications and alerts
- Whatever else becomes a pain point

Constraints:
- Max 2 extensions at a time
- Each must replace an external app, not add novelty
- If it doesn't reduce app‑juggling, it doesn't ship


---

Explicitly Skipped (Without Guilt)

- Per‑token billing or metering UI (Ollama Cloud subscription covers it)
- Full IDE replacement (mobile editor is for targeted edits, not marathon coding)
- Multi‑agent debate loops (agents have roles, not opinions)
- Continuous background monitoring (explicit user‑initiated actions only)
- Team collaboration features (this is a personal tool)
- Social or feed‑based UX
- Desktop‑first features (desktop is secondary, always)


---

Success Definition

This app is successful if:

- It is opened casually on a phone
- It replaces GitSync, GitHub mobile, Claude app, and Codex website
- You can edit, commit, and verify — one app, one flow
- You see what happened in real time and trust the result
- It saves time without demanding attention

If it ever feels impressive, it has likely gone too far.
