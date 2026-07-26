# Runtime Silence Census

**Status:** Current (partially implemented — Wave 0 verify + Wave 1 copy + Wave 2's first PR shipped; Waves 3, 4 and the rest of Wave 2 pending)
**Date:** 2026-07-26
**Scope:** every user-visible moment where the web/native app makes the user aware of the runtime (sandbox, container, snapshot machinery, connectivity). CLI/TUI vocabulary and Worker-side card internals are out of scope. Component/file *names* (`SandboxStatusBanner.tsx` etc.) are out of scope — this census is about copy that reaches a user, not identifiers.

## The problem

The experience complaint, verbatim: *"too many moments where I'm aware of the runtime."* The census below confirms it structurally — the runtime has banners, chips, toasts, countdown clocks, and manual lifecycle controls. The user is cast as the runtime's operator.

This is not a violation of the honest-surfaces principle; it is a misallocation of it. Honesty is owed about the **work** (diff, branch, what the agent did, what a push contains) and to **ops** (structured logs — the symmetric-logs convention already exists for exactly this). It is not owed to the user about **hosting** — where the workspace physically lives this minute and how its lease is doing.

## The law

> The runtime may address the user only when it needs a decision only the user can make.
> Everything else is absorbed: waits become background warms, failures become retries,
> restores become automatic, and machine-truth moves to structured logs.
> User-facing vocabulary is work vocabulary: a workspace is a *place*, never a *process*.
> The word "sandbox" does not appear in user copy.

Corollary for work actions: a work action (commit, push, view files, export) is **never refused because the runtime is cold**. It is accepted, the runtime warms, and the action runs — with at most a progress affordance on the button that was pressed.

## Bins

- **CONSENT** — a real decision about the work. Keep. (Exec approvals, push gates, restore-or-not.)
- **WAIT** — the machine isn't ready yet. Never an announcement or refusal; absorb via queue-on-warm or local-first reads.
- **NARRATION** — the machine describing its own state with no decision attached. Delete, or demote to structured logs.
- **OPERATOR** — a manual lifecycle control (restart, hibernate, snapshot save). Absorb into automation; most of the automation already shipped (#1270 token re-mint + snapshot-on-hide, preservation floor #1558).

Verdicts: **KEEP** · **REWORD** (work vocabulary) · **QUEUE** (accept-and-run-when-ready) · **ABSORB** (automation replaces the control) · **DEMOTE** (structured log, no UI) · **DELETE** · **VERIFY** (confirm live/dead before acting).

## Census

### A. Status chip — `SandboxStatusBanner.tsx` (chat header)

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| A1 | status `creating` | "Starting" / "Sandbox is starting" | WAIT | ABSORB — local-first entry removes the wait from view; until then REWORD ("Preparing workspace") |
| A2 | status `reconnecting` | "Reconnecting" / "Reconnecting to sandbox" | NARRATION | DEMOTE — reconnection self-heals (#1270); log line, no chip state |
| A3 | status `error` | "Sandbox" + categorized title | CONSENT-adjacent | KEEP as the *single* runtime presence surface; titles reworded (see I). **WAVE 1 COPY SHIPPED 2026-07-26:** visible label "Workspace"; fallback title "Workspace needs attention". |
| A4 | status `idle` | "Idle" / "Sandbox is idle" | NARRATION | DELETE — auto-start on demand already exists; idleness is not the user's problem |

Target end-state: the chip has exactly one visible state — error. All healthy states render nothing.

### B. Expiry banner — `SandboxExpiryBanner.tsx`

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| B1 | T−5:00 countdown | "N:NN remaining · Download your work before this workspace runtime expires." | OPERATOR | DELETE — verified live **and false** (see Wave 0 findings). **SHIPPED 2026-07-26 (this PR).** |
| B2 | expired | "Workspace runtime expired · Restart runtime" | OPERATOR | DELETE with B1 — on the shipped provider this fires on a *healthy* runtime; "Restart runtime" would needlessly wipe a live workspace. Transparent restart-on-next-action is already the CF recovery model. **SHIPPED 2026-07-26 (this PR).** |

**Wave 0 findings (2026-07-26).** The banner is *not* dead code: scratch sessions are
reachable (`App.tsx` draft composer + no-repo conversation resume) and start real
sandboxes (`sandboxStart('', 'main')`), so `isScratch` passes non-null props. And its
hardcoded `SANDBOX_LIFETIME_MS = 30 min` is wrong on **both** supported providers:

- **Cloudflare** (shipped default): wrong *shape* — the policy is idle-based
  `sleepAfter: '1h'`, not a fixed lifetime from `createdAt`; an active session can
  live for hours. At minute 30 of a healthy session the banner announces "Workspace
  runtime expired" about a container that is alive.
- **Modal** (supported via the `PUSH_SANDBOX_PROVIDER` wrangler var): wrong *number* —
  `sandbox/app.py` sets `SANDBOX_TIMEOUT_SECONDS = 7200` (a 2h hard deadline), so the
  banner fires 90 minutes early. The component comment calling 30 minutes a "Modal
  container policy" is itself stale. (Credit: the Modal half of this finding is from
  Codex review on #1605 — the census originally repeated the stale comment.)

The T−5 "expiry checkpoint" callback rests on the same false premise; the idle reaper
snapshot and snapshot-on-hide (#1270) are the actual safety nets on CF. Verdict
upgraded from VERIFY to DELETE (banner, both states, and the callback wiring). Any
future lifetime display must derive from the provider's actual policy, not a constant —
and note the same wrong constant is *duplicated* in `RepoLauncherPanel.tsx` (section M),
two independent copies of a number that matches neither provider.

### C. Workspace hub sheet — `WorkspaceHubSheet.tsx`

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| C1 | Hibernate pressed | "Sandbox hibernated — workspace snapshot saved" | OPERATOR | ABSORB — snapshot-on-hide shipped; manual hibernate is a pre-automation vestige. Delete the control (or park behind a debug flag) |
| C2 | Hibernate failed | "Hibernate failed — please try again" | OPERATOR | dies with C1 |
| C3 | Forget snapshot | "Forgot sandbox snapshot — next start will be a clean clone" / "Drop the saved snapshot so the next start is a clean clone" | OPERATOR w/ real intent | REWORD — the *intent* ("start clean") is legitimate work vocabulary. **SHIPPED 2026-07-26:** "Snapshot dropped — next start will be a fresh clone". |
| C4 | Commit target sheet, scratchpad export, commit+push run, suggest-commit-message, commit flow (5 sites) | "Sandbox is not ready." | WAIT | QUEUE — never refuse a work action because the machine is cold |
| C5 | Diff inspect fails | "Unable to inspect sandbox changes." | error | REWORD. **SHIPPED 2026-07-26:** "Couldn't read workspace changes." |
| C6 | Status section | "Sandbox not running" / "Sandbox error" | NARRATION | **COPY SHIPPED 2026-07-26:** "Workspace not running" / "Workspace error". The structural collapse to one workspace status row remains an open behavioral item. |
| C7 | Manual snapshot | "Save sandbox snapshot" | OPERATOR | ABSORB — autosave cadence + on-hide already cover it |
| C8 | Export | "Download sandbox workspace" | CONSENT | KEEP, REWORD. **SHIPPED 2026-07-26:** "Download workspace". |
| C9 | CTA | "New Sandbox" | OPERATOR | **COPY SHIPPED 2026-07-26:** "Fresh workspace". Demoting it to error-recovery-only remains an open behavioral item. |
| C10 | Relay notes | "Notes and pinned artifacts for the paired daemon session." | borderline | KEEP — low-priority reword ("paired local session"); the user paired it deliberately |

### D. Hub settings tab — `HubSettingsTab.tsx`

| # | Copy | Bin | Verdict |
|---|---|---|---|
| D1 | "Runtime warm-up and branch safety." | NARRATION | **REWORD SHIPPED 2026-07-26:** "Workspace warm-up and branch safety." |
| D2 | "Controls for context, sandbox, and branch safety." | NARRATION | **REWORD SHIPPED 2026-07-26:** "Controls for context, workspace, and branch safety." |
| D3 | "The sandbox auto-starts on demand." | NARRATION | **REWORD SHIPPED 2026-07-26:** "Your workspace starts on demand." |

### E. Hub Files / Diff tabs

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| E1 | Runtime cold | "Sandbox is not ready yet." | WAIT | LOCAL-FIRST — native reads from the on-device clone (backend seam); web shows last-known + refresh |
| E2 | Runtime cold | "Starting sandbox..." / **"Start sandbox"** button | WAIT | ABSORB — the census's prime exhibit: the user manually boots a machine to look at their own files. Auto-start on tab open; local-first on native |

### F. Snapshot manager toasts — `useSnapshotManager.ts`

| # | Copy | Bin | Verdict |
|---|---|---|---|
| F1 | "Snapshot autosave paused after 4 hours" | NARRATION | DEMOTE to log |
| F2 | "Snapshot saved" | NARRATION | DEMOTE (or inline tick if a manual save control survives C7) |
| F3 | "Snapshot restored (N files)" | CONSENT result | KEEP |
| F4 | "No snapshot found" / "Restore failed" | error on user action | KEEP, work vocabulary |

### G. Session screen toasts — `WorkspaceSessionScreen.tsx`

| # | Copy | Bin | Verdict |
|---|---|---|---|
| G1 | "Sandbox moved to X (was Y) — Push followed." | NARRATION | **REWORD SHIPPED 2026-07-26:** "Branch changed to X — following." |
| G2 | "Sandbox moved to detached HEAD (was X) — Push did not change branches." | warning | **REWORD SHIPPED 2026-07-26:** "Checked out a detached HEAD (was X) — branch unchanged." |

### H. Connectivity notifications — `sandbox-connectivity-notifications.ts`

| # | Copy | Bin | Verdict |
|---|---|---|---|
| H1 | "Sandbox needs attention" + "Open the workspace status for retry and restart options." | OPERATOR | ABSORB — auto-retry; only terminal failure surfaces, as a workspace error |
| H2 | "Reconnecting to sandbox..." | NARRATION | DEMOTE |
| H3 | "Sandbox reconnected" | NARRATION | DELETE — success is silence |
| H4 | "Sandbox idle. Code tools will start it again when needed." | NARRATION | DELETE — the second clause proves the first needs no announcement |

### I. Error taxonomy — `sandbox-error-utils.ts` (feeds chip + hub)

| # | Copy | Verdict |
|---|---|---|
| I1 | "Repository clone failed" | KEEP — already work vocabulary. **DETAIL COPY SHIPPED 2026-07-26:** "Check repo access and try a fresh workspace." |
| I2 | "Sandbox timed out" / "The container stopped responding." | **REWORD SHIPPED 2026-07-26:** "Workspace stopped responding" / "The workspace stopped responding." |
| I3 | "Sandbox unreachable" / "Could not connect to the container." | **REWORD SHIPPED 2026-07-26:** "Workspace unreachable" / "Could not connect to the workspace." |
| I4 | "Sandbox session expired" | **REWORD SHIPPED 2026-07-26:** "Workspace session expired". Transparent-restart absorption remains open. |
| I5 | "Authentication error" (GitHub token) | KEEP — real decision |
| I6 | "Out of memory" | KEEP. **DETAIL COPY SHIPPED 2026-07-26:** "The workspace ran out of memory." |
| I7 | "Sandbox error" (fallback) | **REWORD SHIPPED 2026-07-26:** "Workspace error". |

### J–L. Singles

| # | Surface | Copy | Bin | Verdict |
|---|---|---|---|---|
| J1 | FileBrowser (native) | "Commit & Push from Files is not available for native workspaces yet." | capability gap narrated as topology | FIX — wire native commit/push (typed plugin methods exist); the copy dies with the gap |
| K1 | Relay | "Could not reach the daemon to resume this session." | CONSENT (retry/pair) | KEEP — optional reword "your machine" |
| L1 | Publish flow | "Sandbox is not ready yet. Try again in a moment." | WAIT | QUEUE |
| L2 | Publish flow | "Wait for the current response to finish before publishing." | work wait | KEEP — it's about the work |
| L3 | Publish flow | "Connect GitHub in Settings before publishing this workspace." | CONSENT | KEEP |

### M. Repo launcher panel — `RepoLauncherPanel.tsx`

Missed by the census's first pass; surfaced by Codex review on #1605. The launcher
duplicates the expiry banner's model with its own copy of the wrong constant
(`SANDBOX_SESSION_LIFETIME_MS = 30 min`) — a second, independent false countdown.

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| M1 | status `ready` | "Sandbox session active - N min left" (green, amber inside 5 min) | NARRATION | DELETE — false countdown on both providers, same grounds as B1/B2. **SHIPPED 2026-07-26 (this PR).** |
| M2 | status `creating` | "Sandbox is starting" | WAIT | ABSORB — aligns with A1; local-first entry removes the wait from view |
| M3 | status `reconnecting` | "Reconnecting to your sandbox" | NARRATION | DEMOTE — aligns with A2 |
| M4 | status `error` | "Sandbox needs attention before you continue" | CONSENT-adjacent | **REWORD SHIPPED 2026-07-26:** "Workspace needs attention before you continue". Error remains the one state that earns pixels (A3). |

## Tallies

Each row is counted once, under its primary outcome (a "KEEP, REWORD" row counts as
REWORD — the moment survives with new copy; E1's LOCAL-FIRST counts as ABSORB — the
wait is absorbed by local reads).

47 rows (A1–M4):

| Outcome | Count | Rows |
|---|---|---|
| KEEP | 10 | A3, C10, F3, F4, I1, I5, I6, K1, L2, L3 |
| REWORD | 14 | C3, C5, C6, C8, C9, D1, D2, D3, G1, G2, I2, I3, I7, M4 |
| QUEUE | 2 (6 call sites) | C4 (5 sites), L1 |
| ABSORB | 7 | A1, C7, E1, E2, H1, I4, M2 |
| DEMOTE | 5 | A2, F1, F2, H2, M3 |
| DELETE | 8 | A4, B1, B2, C1, C2, H3, H4, M1 |
| FIX | 1 | J1 |

37 of 47 rows — a little under four-fifths of the runtime's speaking roles — are
cuttable or rewritable without losing a single real decision.

## Burn-down

- **Wave 0 — verify: DONE 2026-07-26.** `SandboxExpiryBanner` is live on the scratch lane and factually wrong on **both** providers (findings under section B), and the launcher panel duplicates the same wrong constant (section M). Wave 2's first item is deleting both countdown surfaces, not a dead-code sweep.
- **Wave 1 — copy: DONE 2026-07-26.** Every REWORD plus the A3/I1/I4/I6 law-compliance copy shipped, and `no-restricted-syntax` pins the user-copy channels. After a review finding that the initial pin (literal JSX + direct `toast.*()`) missed expression-based copy, the selectors were extended to JSX expression literals/templates, visible attributes (`title`/`aria-label`/`placeholder`/`alt`), and copy-bearing config properties (`title`/`label`/`detail`/`description`) — which surfaced and reworded ~24 further visible strings (BranchSwitchConfirm, WorkspacePatchCard, the chip tooltips, the E-tab buttons, the C4 refusals, and more). **Convention:** later-wave rows now carry law-compliant *wording* while keeping their scheduled fate — the census tables, not lint disables, track the burn-down. The only `eslint-disable` exemptions are annotated internals: tool names in model-facing guidance (tool identifiers are exempt from the pin by design). Internal enum/type literals were hoisted to module scope rather than exempted. C6's structural collapse and C9's error-recovery-only gating remain open behavioral items; Wave 1 changed their strings only.
- **Wave 2 — silence (small PRs; FIRST PR DONE 2026-07-26):** B1/B2/M1 and the false T−5 expiry-checkpoint callback shipped in this PR. DELETE/DEMOTE the remaining narration set. Each deletion must first confirm its automation actually covers the case (per the self-review rule: execute the claim — kill a reconnect toast only after watching a reconnection heal silently). Structured logs gain what the UI loses.
- **Wave 3 — queue-on-warm (medium):** C4 + L1. One shared "accept, warm, run" affordance replaces six refusal sites; the E-tab waits (E1/E2) die in Wave 4's local-first entry instead.
- **Wave 4 — local-first entry (the big one, scoped separately):** hub Files/Diff/status paint from the native clone (backend seam) before any runtime exists; chat attaches when ready. Kills the A1 wait class at the root rather than restyling it.

## Resolved questions (veto pass, 2026-07-26)

1. **Hibernate: delete outright.** Snapshot-on-hide + autosave cover the intent; no debug flag. C1/C2 verdicts confirmed as full deletions.
2. **"New Sandbox": error-recovery only.** "Fresh workspace" appears as a repair affordance when the workspace is in an error state, never as a standing control.
3. **Chip end-state: nothing at rest.** The chip renders only in the error state; starting/idle/reconnecting are invisible. Success is silence.
4. **"Workspace" confirmed as the user-facing noun** for the place. Wave 1 bakes it into every string; "sandbox" is banned from user-facing copy and a lint pin enforces the ban.
