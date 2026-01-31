Mobile GitHub Analyzer — 3‑Agent Roadmap

Purpose A personal, mobile‑first GitHub PR analysis app optimized for quick judgment passes away from the desktop. The app prioritizes clarity, trust, and low cognitive load over feature breadth.

This roadmap assumes a three‑agent architecture:

Claude — Conversational interface and orchestration

Codex — Implementation and code mutation

Gemini — Narrow, deterministic analysis and auditing


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

Claude — Conversational Orchestrator

Role: Translate human intent into structured actions.

Responsibilities:

Interpret user intent ("check this PR", "is this risky")

Decide which agent(s) to invoke

Present results in clear, readable language


Constraints:

No direct repo access

No code writing

No analysis generation


Claude never does the work. Claude routes the work.


---

Codex — Mechanic

Role: Implementation and code manipulation.

Responsibilities:

Apply patches

Generate diffs

Explain code changes when requested


Constraints:

No decision‑making authority

No self‑review

No user conversation


Codex only acts when explicitly summoned.


---

Gemini — Auditor

Role: Narrow, deterministic analysis engine.

Responsibilities:

Analyze PR diffs

Identify risks and regressions

Classify logical vs mechanical changes

Flag hotspots


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

Deterministic Gemini prompt

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

Gemini produces graded assertions

Claude summarizes verdict and caveats


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

Phase 3 — Claude Interface (Optional)

Goal: Add a lightweight conversational layer for intent clarification.

Features:

Single input field for intent

Predefined intents ("quick scan", "deep risk")

Read‑only clarification prompts


Constraints:

No freeform chat

No long conversations


Exit Criteria:

Claude reduces friction, not increases complexity



---

Phase 4 — Codex Integration (Desktop‑Adjacent)

Goal: Enable action follow‑ups when back at a workstation.

Features:

"Generate patch" action (desktop only)

Diff previews

Export suggestions


Constraints:

Mobile remains read‑only


Exit Criteria:

Clear boundary between review (mobile) and action (desktop)



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