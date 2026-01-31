Mobile GitHub Analyzer — Role‑Based Agent Roadmap

Purpose A personal, mobile‑first GitHub PR analysis app optimized for quick judgment passes away from the desktop. The app prioritizes clarity, trust, and low cognitive load over feature breadth.

This roadmap assumes a role‑based architecture. Models are replaceable. Roles are sacred.

Orchestrator — gpt‑oss‑120b (primary), kimi‑k2‑thinking (optional)

Interpreter — nemotron‑3‑nano (primary), mistral‑large‑3 (optional)

Coder — qwen3‑coder (primary), glm‑4.7 (secondary), deepseek‑v3.2 (heavy jobs)

Auditor — gemini‑3‑flash (primary), gemini‑3‑pro (second opinion)

Philosophy: Small, opinionated menus per role — not a single champion. Trade theoretical peak performance for psychological sustainability.

The mobile experience is the primary constraint. Desktop parity is optional.


---

Design Principles (Non‑Negotiable)

1. Mobile First, Not Mobile Friendly The app must feel natural on a phone. Desktop is secondary.


2. Judgment Over Assistance The app helps answer: “Is this PR safe?” — not “How do I code?”


3. One Action Per Screen Each screen does one thing well. No dense dashboards.


4. Quiet Confidence Fewer words. Structured output. Clear uncertainty labeling.


5. No Chat by Default Conversation exists only where it adds clarity, not everywhere.




---

Agent Roles (Locked)

gpt‑oss‑120b — Orchestrator (boring, cautious, upstream)

Role: Translate human intent into structured actions.

Primary: gpt‑oss‑120b
Optional alt: kimi‑k2‑thinking (for speed or exploration)

Why gpt‑oss‑120b wins by default:

Excellent schema obedience

Very good at "don't act unless sure"

Predictable under load

Feels like infrastructure, not personality


Kimi‑k2‑thinking is interesting but more assertive than conservative. Thinking mode helps, but temperament is still exploratory.

Responsibilities:

Interpret user intent ("check this PR", "is this risky")

Decide which agent(s) to invoke

Present results in clear, readable language


Constraints:

No direct repo access

No code writing

No analysis generation


The orchestrator should never surprise you. It routes the work, never does the work.


---

nemotron‑3‑nano — Interpreter / Mediator

Role: Resolve ambiguity and clean up intent before routing.

Primary: nemotron‑3‑nano
Optional alt: mistral‑large‑3 (when more prose is needed)

Why nemotron‑3‑nano:

Doesn't try to steal the show

Structured and efficient

Doesn't get emotionally attached to solutions

The calm adult who rewrites "clean this up" into something actionable


Responsibilities:

Rewrite vague user input into structured, actionable intents

Mediate between orchestrator output and agent input

Normalize ambiguous requests


Constraints:

No direct execution

No code generation

No final decision authority


nemotron‑3‑nano clarifies. It never decides.


---

qwen3‑coder — Coder (patches, diffs, repo work)

Role: Implementation and code manipulation.

Primary: qwen3‑coder
Secondary: glm‑4.7
Optional heavy: deepseek‑v3.2 (use sparingly — powerful but expensive)

Why this pool:

qwen3‑coder — Excellent long‑context code edits, disciplined output, good tool usage

glm‑4.7 — Solid "mechanic" energy, less hallucination than expected

deepseek‑v3.2 — Powerful but expensive cognitively and monetarily


Do NOT use as primary coders: Kimi (too opinionated), Nemotron (not specialized), Mistral‑large (generalist, not surgical)

Responsibilities:

Apply patches

Generate diffs

Explain code changes when requested


Constraints:

No decision‑making authority

No self‑review

No user conversation


Rule: Coders generate patches. They do not decide what patches mean. They only act when explicitly summoned.


---

gemini‑3‑flash / gemini‑3‑pro — Auditor / Utility

Role: Narrow, deterministic analysis engine and utility reviewer.

Primary: gemini‑3‑flash (audits, summaries, sanity checks)
Secondary: gemini‑3‑pro (second opinion, not control)

Why Gemini earns its keep here:

Bad at multitasking by design, which ironically makes it great as a reviewer

gemini‑3‑flash is fast and focused for routine audits

gemini‑3‑pro adds depth when you want a second opinion


Responsibilities:

Analyze PR diffs

Identify risks and regressions

Classify logical vs mechanical changes

Flag hotspots

Quick summaries and sanity checks


Constraints:

No questions

No feature suggestions

No conversation

Hardcoded prompts only


Gemini never initiates work. It evaluates artifacts produced by others.


---

Roadmap

Phase 0 — Stabilization (Done / In Progress)

Goal: Solidify the existing mobile web app foundation.

Mobile‑first layout locked

Demo mode for zero‑auth usage

Deterministic gemini‑3‑flash prompt

Collapsible result sections


Exit Criteria:

App usable one‑handed

No horizontal scroll

Analysis readable in <2 minutes



---

Phase 1 — Mobile Judgment Pass (Next)

Goal: Make PR evaluation fast, scannable, and trustworthy on a phone.

Features:

Binary verdict: Would I block this PR? (clearly labeled AI judgment)

Risk severity filtering (High / All)

Confidence scores on risks

"What didn’t change" stability section


Agent Use:

gemini‑3‑flash produces graded assertions

gpt‑oss‑120b summarizes verdict and caveats

nemotron‑3‑nano normalizes user intent before routing


Exit Criteria:

User can decide "merge or not" without scrolling everything



---

Phase 2 — OAuth & Reliability

Goal: Reduce friction without increasing scope.

Features:

Optional GitHub OAuth (read‑only scopes)

Rate‑limit transparency

Private repo support


Constraints:

OAuth changes access only, not analysis behavior


Exit Criteria:

App works reliably on real PRs without manual tokens



---

Phase 3 — Orchestrator Interface (Optional)

Goal: Add a lightweight conversational layer for intent clarification.

Features:

Single input field for intent

Predefined intents ("quick scan", "deep risk")

Read‑only clarification prompts

nemotron‑3‑nano handles ambiguity resolution before orchestrator routing


Constraints:

No freeform chat

No long conversations


Exit Criteria:

gpt‑oss‑120b reduces friction, not increases complexity



---

Phase 4 — Coder Integration (Desktop‑Adjacent)

Goal: Enable action follow‑ups when back at a workstation.

Features:

"Generate patch" action via qwen3‑coder (desktop only)

glm‑4.7 as fallback coder for secondary tasks

deepseek‑v3.2 available for heavy refactoring jobs

Diff previews

Export suggestions


Constraints:

Mobile remains read‑only

Coders generate patches — they do not decide what patches mean


Exit Criteria:

Clear boundary between review (mobile) and action (desktop)



---

Phase 2.5 — GitSync & Repo Awareness

Goal: Enable lightweight repository synchronization and awareness so the app can replace GitSync and reduce dependence on the GitHub mobile app.

Scope (Mobile‑First):

Periodic pull of:

Recent commits

Open PRs

Branch heads


Local cache of repo metadata for offline viewing

Manual "Sync Now" action (no background polling)


Features:

Repo list with last‑sync timestamp

PR status overview (open / draft / merged)

Commit summaries since last sync

Diff previews (read‑only, mobile‑optimized)


Agent Use:

gemini‑3‑flash: not used (no analysis during sync)

gpt‑oss‑120b: optional summarization of "what changed since last check"

nemotron‑3‑nano: normalizes sync context for orchestrator


Constraints:

Read‑only operations only

No push, merge, or write actions

Explicit user‑initiated sync


Exit Criteria:

App can replace GitSync for passive repo monitoring

App is useful offline for recent state inspection



---

Explicitly Skipped Models (for now)

These can be safely ignored without guilt:

cogito‑2.1 (overkill, unclear niche)

devstral‑large/small (redundant with qwen3‑coder + glm‑4.7)

minimax‑m2.x (fine, but nothing unique)

gemma3 (great local model, not special in cloud)

qwen3‑vl (vision isn't the bottleneck right now)

You're not building a zoo. You're building a workstation.


---

Explicit Non‑Goals

Full IDE replacement

Multi‑agent debate loops

Continuous background monitoring

Team collaboration features

Social or feed‑based UX



---

Success Definition

This app is successful if:

It is opened casually on a phone

It produces calm, believable output

It saves time without demanding attention


If it ever feels impressive, it has likely gone too far.