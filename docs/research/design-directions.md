# Push Design Directions

Status: Research / opinionated reference (synthesized).

A consolidated, de-personified list of design directions for Push, distilled from
several design-lens explorations into one set of ideas. The point of collapsing them:
five of the explorations re-derived the *same* thesis from unrelated starting points,
which is itself the signal —

> **Push should feel like a single capable mind, not a dashboard you operate.**

Items are tagged `[tracked]` (already has a roadmap/PR track), `[partial]` (exists in
some form), or `[fresh]` (not yet on a track). This is research, not a roadmap
commitment, and nothing here overrides `ARCHITECTURE.md` or the role/session contracts.

---

## 1. Collapse the operator surface

The user is a person with intent, not a system operator. Every affordance that reminds
them they are managing git, models, branches, sandboxes, or safety gates is a tax on
taste. The move is not to remove the safety, branching, or runtime roles — it is to stop
asking the user to understand the hood.

- **Default to the transcript.** Strip the canvas to the conversation; no persistent
  branch badge, model picker, or role/status chrome. Anything that matters emerges
  inline as a card or suggestion, reachable by gesture or request rather than menu
  furniture. `[tracked]` — the single conversational lead is the north star.
- **No user-facing role org-chart.** Orchestrator/Explorer/Coder/Reviewer/Auditor are
  runtime separation of concerns, not vocabulary the user should rehearse. Attribution
  stays conversational: "I'm looking into that," "I made the edit," "I asked another pass
  to double-check," "Ready to ship when you are." `[tracked]` — `role-display.ts`.
- **One ship action, one mode.** Collapse commit / prepare-push / push / draft into a
  single intent ("This looks good — ship it?") with consequences surfaced, not three
  buttons. Back it with a single **Auto / Review / Manual** setting — how much do you want
  to be in the loop right now — instead of a matrix of gates. `[partial]` — full-auto /
  supervised modes exist; the collapse into one verb does not.
- **Intent-first composer.** "Make the login flow work offline" should be enough. If the
  agent needs a branch, a test, or a model switch, it asks once in context rather than
  making the user preconfigure the workspace. `[fresh]`
- **One ambient health card.** Replace scattered indicators (sandbox alive, branch,
  Auditor, provider, CI) with one plain-language card: "I'm ready," "I'm thinking," or "I
  need you to decide X." Tap to expand the mechanics. `[fresh]` — independently proposed
  by three of the source lenses, which is a strong vote.

## 2. Memory, search, and anticipation

Treat conversation, code, and context as one searchable, surfacable body of knowledge.
The user should not have to ask the right question or remember which branch holds a fact.

- **Resume as memory, not state management.** Returning to Push lands you exactly where
  you left off — pending changes, the last question, recent context — with no "reconnect
  sandbox," "select branch," or stale-diff ritual. `[tracked]` — session-continuity +
  sandbox-persistence work.
- **Universal search.** One search interface spanning chat history, diffs, commits,
  scratchpad, todos, CI runs, memory records, and reasoning traces. Answers "what did we
  decide about JGit?" with the chat turn, the decision doc, and the relevant commit.
  `[fresh]` — closest existing primitive is semantic memory retrieval.
- **Branch-scoped activity feed.** A single searchable "river" of what happened on the
  branch — agent tool calls, test runs, failed edits, checkpoint restores, partial pushes
  — answering "what happened while I was away?" without scrolling chats or running
  `git log`. `[fresh]` — adjacent to the durable-runs track.
- **Predictive next-action chips.** Under each assistant turn, a quiet, dismissible row of
  likely follow-ups, combining heuristics (a passing test usually wants a commit), user
  history, and repo state (CI failed → "view failure" is prominent). Never blocking. `[fresh]`
- **Implicit memory suggestions.** Rather than asking the user to groom a scratchpad, the
  agent drafts memory entries from recurring subjects and unstated decisions; the user
  reviews, edits, or rejects. `[partial]` — memory/scratchpad exist; auto-drafting does not.

## 3. Cheap experiments and extensibility

Make trying another path cheap and reversible, and give power users enough surface to
surprise you.

- **Speculative forks.** "What if we used SQLite instead?" spawns a transient branch, runs
  the experiment, and reports back in a collapsed thread inside the current chat. The
  original branch is untouched; adopt, discard, or promote. `[tracked]` — pre-order PRs /
  isolated worktrees.
- **Lightweight extensibility.** Let users write custom tool wrappers or share session
  templates without a plugin marketplace — just enough surface area to make the tool
  theirs without permission. `[fresh]`
- **Cheap local heuristics over model brute force.** Prefer ripgrep/AST-first discovery to
  spending tokens and latency asking a frontier model to locate a symbol; feed pinpointed
  line ranges to the model. `[partial]` — already largely how Push works; worth keeping as
  an explicit principle.

## 4. Invisible measurement

The one genuinely distinct vein. Push already sits on most of the data a disciplined
personal-process loop wants (timestamped phases, typed review findings, intent vs.
outcome) — the gap is synthesis and feedback, not collection. The rule: surface insight
from data the user already generates, without a single manual step. If it needs a form or
a spreadsheet, it has failed.

- **Automatic phase accounting.** A session-end summary as a byproduct: "4 min planning,
  12 min coding across 3 files, 2 min review (1 finding, fixed), 1 min testing. Your
  estimate was 'quick fix' — actuals say medium." `[fresh]`
- **Defect log from review findings.** Persist Reviewer/Auditor findings as typed defect
  records with injection-phase inference (a finding on a line the agent just wrote =
  coding-phase; a wrong-approach finding = design-phase; a finding on untouched code =
  pre-existing). The diff makes this distinguishable automatically. `[fresh]`
- **Estimate vs. actual, from conversation.** Capture informal estimates ("this should be
  quick") and compare to actual scope, surfaced as a sentence and a trend, never a chart.
  `[fresh]`
- **A review checklist that evolves.** Let the defect log inform review focus: "You've had
  4 type-related findings in the last 10 tasks — checking types first this time." Turns the
  Reviewer from a static gate into a coach that adapts to the user's own weaknesses. `[fresh]`

## 5. The flavor question — calm over cute

The source explorations carried a thick theatrical layer (retro metaphors, sound effects,
agent avatars, ceremony). Most of it reads as cute rather than calm and is held here as a
deliberate cut. The bar: a flourish must be punctuation, not prose — skippable, fast, and
opt-in.

- **Maybe worth one experiment each:** a single calm ceremony at the ship moment (a brief
  diff zoom + one-line summary); subtle mobile haptics on a small vocabulary of state
  transitions (run complete, error, ready).
- **Cut:** 8-bit coin/buzzer sounds, ASCII "dungeon map" branch views, Codec-call agent
  avatars, retro "save-slot" reskins of checkpoints, auteur "director's cut" merge
  summaries. High cute, low substance; revisit only if a focused prototype earns its place
  on user *tolerance*, not delight.

---

## What this is not

Not a proposal to remove the Auditor, typed tools, branch scoping, or runtime roles —
those stay under the hood. Not a proposal to add cloud dependencies, analytics, time
tracking, gamification, or a retro skin. The throughline is interaction style: infer
organization, surface relevant history, collapse common paths into intent, and feed the
user's own data back as insight — while the safety and resilience stay invisible defaults
that feel like competence rather than controls.

The test for any direction here: **does it make the user feel like they are commanding an
intent, or operating software?** Only the former earns the pixels.
