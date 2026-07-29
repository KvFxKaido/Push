# Runtime Silence Census

**Status:** Current (partially implemented — Waves 0–3 and 4b shipped; Waves 4a, 4c, and 5 scoped, pending)
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
| A2 | status `reconnecting` | "Reconnecting" / "Reconnecting to sandbox" | NARRATION | DEMOTE — reconnection self-heals (#1270); log line, no chip state. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| A3 | status `error` | "Sandbox" + categorized title | CONSENT-adjacent | KEEP as the *single* runtime presence surface; titles reworded (see I). **WAVE 1 COPY SHIPPED 2026-07-26:** visible label "Workspace"; fallback title "Workspace needs attention". |
| A4 | status `idle` | "Idle" / "Sandbox is idle" | NARRATION | DELETE — auto-start on demand already exists; idleness is not the user's problem. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |

Target end-state: the chip has exactly one visible state — error. All healthy states render nothing.

### B. Expiry banner — `SandboxExpiryBanner.tsx`

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| B1 | T−5:00 countdown | "N:NN remaining · Download your work before this workspace runtime expires." | OPERATOR | DELETE — verified live **and false** (see Wave 0 findings). **SHIPPED 2026-07-26 (Wave 2 PR 1).** |
| B2 | expired | "Workspace runtime expired · Restart runtime" | OPERATOR | DELETE with B1 — on the shipped provider this fires on a *healthy* runtime; "Restart runtime" would needlessly wipe a live workspace. Transparent restart-on-next-action is already the CF recovery model. **SHIPPED 2026-07-26 (Wave 2 PR 1).** |

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
| C1 | Hibernate pressed | "Sandbox hibernated — workspace snapshot saved" | OPERATOR | ABSORB — snapshot-on-hide shipped; manual hibernate is a pre-automation vestige. Control deleted outright. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| C2 | Hibernate failed | "Hibernate failed — please try again" | OPERATOR | died with C1. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| C3 | Forget snapshot | "Forgot sandbox snapshot — next start will be a clean clone" / "Drop the saved snapshot so the next start is a clean clone" | OPERATOR w/ real intent | REWORD — the *intent* ("start clean") is legitimate work vocabulary. **SHIPPED 2026-07-26:** "Snapshot dropped — next start will be a fresh clone". |
| C4 | Commit target sheet, scratchpad export, commit+push run, suggest-commit-message, commit flow (5 sites) | "Sandbox is not ready." | WAIT | QUEUE — never refuse a work action because the machine is cold. **SHIPPED 2026-07-26 (Wave 3):** all five sites accept-warm-run (`useWarmAction` over the controller's `ensureSandbox`, reservation before the first await); the dead-button `!sandboxReady` disables went with the toasts; failure copy is "Workspace could not start. Try again in a moment." |
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
| E1 | Runtime cold | "Sandbox is not ready yet." | WAIT | LOCAL-FIRST — native reads from the on-device clone (backend seam); web reads GitHub's pushed state via the read tier (see Wave 4 findings) |
| E2 | Runtime cold | "Starting sandbox..." / **"Start sandbox"** button | WAIT | ABSORB — the census's prime exhibit: the user manually boots a machine to look at their own files. Auto-start on tab open; local-first on native |

**Wave 4 findings (2026-07-27).** Four things the one-line burn-down entry did not
account for. Each changes what Wave 4 has to build. Findings 2 and 3 were corrected in
review (#1612) after both bots converged on the same passages — the corrections are
marked inline, since the errors are instructive: each one made Wave 4 look *smaller*
than it is.

1. **The seam exists; it stops one layer short.** `resolveNativeFs` →
   `NativeFsBackend` already routes read / write / batch-write / list / search /
   symbols / diff for the **tool** layer (`app/src/lib/sandbox-tools.ts`, #1356), plus
   native `PushGit` and branch ops. But both file UIs — `HubFilesTab` and the
   full-screen `FileBrowser` section — go through `useFileBrowser(sandboxId)` →
   `sandbox-client.listDirectory` → HTTP. On a flag-on native session the *agent*
   reads the on-device clone while the *file browser* reads the cloud sandbox: two
   views of one session. Wave 4's native arm promotes an existing seam up one layer;
   it does not build one.
2. **The `isNativeWorkingCopyEnabled` doc comment is stale — but the flag's caution is
   not.** The comment claims "the non-git tools (exec, file read/write) still route to
   the cloud sandbox by `sandboxId`", written in #1353 (2026-07-06); #1356
   (2026-07-08) native-routed read/write/list/diff/search, so on *file ops* it is
   simply wrong. What survives is larger than the comment's framing and larger than
   this finding first claimed (**corrected in review, #1612** — the original text said
   "only `sandbox_exec` remains", which was the conclusion that made flipping the flag
   look cheap): seven tools return `NATIVE_TOOL_UNSUPPORTED` on a native session —
   `sandbox_exec`, `sandbox_run_tests`, `sandbox_check_types`,
   `sandbox_verify_workspace`, `sandbox_show_commit`, `sandbox_download`, and
   `sandbox_find_references` (`sandbox-tools.ts`; pinned by
   `sandbox-tools-native-fs.test.ts`). These are *designed* refusals, not wiring gaps —
   the native shell has no command runtime and the symbol extractor is a Python script
   that runs inside the sandbox — but they are a real capability delta: a flag-on
   session loses the entire verification class. So the comment needs correcting on
   facts while the flag's posture stands on better grounds than it states. Wave 4
   rewrites the comment to name the seven; flipping the default stays its own decision,
   and this finding makes it a heavier one, not a lighter one.
3. **The web arm's substrate already shipped — it is the read tier, not a cache.**
   This row previously read "web shows last-known + refresh", but there is no
   last-known to show: hub `diffData` is `useState` in `WorkspaceHubSheet` and dies
   with the sheet. `mapSandboxReadToGitHubCall` + the read-tier fallback (Agent
   Runtime Decisions §11) already serve `read_file` and `list_directory` from the
   branch's pushed state, annotated as not reflecting dirty edits. The web Files tab
   *can* paint from that cold once 4a wires it — a real read, no new persistence. It is
   not wired today: `useFileBrowser.loadDirectory` early-returns without a `sandboxId`
   and calls `sandbox-client.listDirectory` directly, and the fallback mapper has no
   importer in any UI. **Two boundaries on that substrate.** (a) `search_files` is
   *excluded on feature branches* — `tryGitHubReadFallback` declines the mapping when
   `currentBranch !== defaultBranch` because GitHub code search is not branch-aware, so
   there is no cold search source off the default branch and 4a must not imply one.
   (b) GitHub is the *degraded* tier by contract, never the preferred one: pushed state
   omits uncommitted edits, so it may only be read when the working-tree source is
   unavailable (see the 4a routing rule).
4. **Files and Diff do not split the same way.** Files has a cold source on both
   surfaces (local clone / GitHub pushed state). Diff has one only on native:
   uncommitted working-tree changes exist nowhere but the sandbox on web. So web Diff
   is *silent auto-warm*, not local-first, and saying "Files/Diff paint from the
   native clone" flattens two different mechanisms into one.

**And a defect in the surface Wave 4 rewrites — confirmed by execution, 2026-07-27.**
`HubDiffTab` has no initial load. `refreshDiff` fires only on the Refresh button;
`WorkspaceHubSheet`'s "Auto-load diff when opening diff tab" effect has an **empty
body** and a comment asserting the tab handles it, which it does not. Rendering the
tab with `sandboxStatus: 'ready'` and `diffData: null` produces:

> main · Refresh · **No working tree changes.**

The runtime states a fact about the user's work without having looked. This is not a
narration nit — the law owes honesty about *the work*, and this is the failure mode
the law exists to prevent. Wave 4b opens with the regression test (there are currently
no tests on `HubDiffTab` or `HubFilesTab` at all).

### F. Snapshot manager toasts — `useSnapshotManager.ts`

| # | Copy | Bin | Verdict |
|---|---|---|---|
| F1 | "Snapshot autosave paused after 4 hours" | NARRATION | DEMOTE to log. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| F2 | "Snapshot saved" | NARRATION | DEMOTE autosave success to log; retain the existing manual-save toast while C7 survives. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
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
| H2 | "Reconnecting to sandbox..." | NARRATION | DEMOTE. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| H3 | "Sandbox reconnected" | NARRATION | DELETE — success is silence. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
| H4 | "Sandbox idle. Code tools will start it again when needed." | NARRATION | DELETE — the second clause proves the first needs no announcement. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |

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
| L1 | Publish flow | "Sandbox is not ready yet. Try again in a moment." | WAIT | QUEUE. **Wave 3 finding:** already warmed via `ensureSandbox` — the message was the *failure* path wearing refusal copy; reworded 2026-07-26 |
| L2 | Publish flow | "Wait for the current response to finish before publishing." | work wait | KEEP — it's about the work |
| L3 | Publish flow | "Connect GitHub in Settings before publishing this workspace." | CONSENT | KEEP |

### M. Repo launcher panel — `RepoLauncherPanel.tsx`

Missed by the census's first pass; surfaced by Codex review on #1605. The launcher
duplicates the expiry banner's model with its own copy of the wrong constant
(`SANDBOX_SESSION_LIFETIME_MS = 30 min`) — a second, independent false countdown.

| # | Trigger | Copy | Bin | Verdict |
|---|---|---|---|---|
| M1 | status `ready` | "Sandbox session active - N min left" (green, amber inside 5 min) | NARRATION | DELETE — false countdown on both providers, same grounds as B1/B2. **SHIPPED 2026-07-26 (Wave 2 PR 1).** |
| M2 | status `creating` | "Sandbox is starting" | WAIT | ABSORB — aligns with A1; local-first entry removes the wait from view |
| M3 | status `reconnecting` | "Reconnecting to your sandbox" | NARRATION | DEMOTE — aligns with A2. **SHIPPED 2026-07-26 (Wave 2 PR 2).** |
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
- **Wave 2 — silence: DONE 2026-07-26 (two PRs).** PR 1 shipped B1/B2/M1 and the false T−5 expiry-checkpoint callback. PR 2 shipped the remaining DELETE/DEMOTE narration set (A2/A4/C1/C2/F1/F2/H2/H3/H4/M3). The surviving manual C7 save keeps its success toast until that control is absorbed; autosave success is logged.
- **Wave 3 — queue-on-warm: DONE 2026-07-26.** C4's five sites run through `useWarmAction` (warm reserved before the first await, per-button progress affordance, honest failure copy — and the dead-button `!sandboxReady`/`!sandboxId` disables removed, which were refusals without even a message). L1 turned out to be already-warmed with mislabeled failure copy, now reworded. The E-tab waits (E1/E2) die in Wave 4's local-first entry instead. **Boundary note (from #1610 review, both bots converging):** accept-warm-run applies only where a workspace *can* warm — chat/relay surfaces have no workspace-start implementation, so their work actions are *absent* (capability), never warmed-and-failed; the scratchpad export gates on `workspaceMode`.
- **Wave 4 — local-first entry (the big one): SCOPED 2026-07-27.** Rows A1, E1, E2, M2. Kills the A1 wait class at the root rather than restyling it. Three PRs, and the order is load-bearing:
  - **4a — Files, both surfaces, plus native Diff.** A UI-level read seam behind `useFileBrowser`, so `HubFilesTab` and the `FileBrowser` section inherit it together. Retires E1/E2's refusal copy and Start-workspace button, and closes the native split-brain (finding 1). Native Diff belongs to this native-read seam too; 4b deliberately stays cloud-only.
    - **Routing is state-dependent, not a fixed precedence** (corrected in review, #1612 — both bots converged; the original "native clone → GitHub → sandbox" read as unconditional and would have shown *stale* files on a warm web session after in-sandbox edits). The rule: a flag-on native session reads the on-device clone, always — it is the working tree. A web session reads the cloud sandbox whenever one is ready, and GitHub pushed state **only while the sandbox is cold or unreachable**, matching the read-tier contract. Cold GitHub reads carry the same "last pushed state" annotation the tool tier already applies; a warm sandbox is never bypassed.
    - **Scope is the whole read path, not just the listing.** Changing `useFileBrowser` alone reroutes directory listings and nothing else: `HubFilesTab.loadFilePreview` calls `readFromSandbox` directly, and `WorkspaceSessionScreen.tsx:566` gates the full-screen browser on `showFileBrowser && sandbox.sandboxId` — a render gate *above* the hook, so a cold session never reaches it. 4a covers all three: listing, content read, and the parent render gate.
    - **Mutations are explicitly out.** Upload / delete / rename / `FileEditor` writes stay on the HTTP client in 4a. On native that leaves writes cloud-bound while reads are local, so the native file browser is **read-only by construction in 4a** — the mutation controls are *absent*, not refused, per the Wave 3 capability boundary. Wiring native mutations joins J1 in Wave 5.
  - **4b — Diff, web auto-warm: SHIPPED 2026-07-29.** The production-tab regression first reproduced the unchecked "No working tree changes." claim. `HubDiffTab` now runs a guarded first-visible load through Wave 3's `useWarmAction`, then always reads `getSandboxDiff` from the warmed cloud workspace. The sheet that owns diff data also owns base invalidation and a monotonic generation, so branch changes clear stale state while the tab is unmounted and A→B→A cannot let A1 publish into or clear flags owned by A2. A warm reservation is released only by the run that acquired it; its observable release retriggers the current generation. An empty result is retained as checked data so tab re-entry cannot confuse "not loaded" with "clean." The Start-workspace refusal surface and the parent's empty auto-load effect are gone; warm failure keeps the Wave 3 honest-failure copy. Native Diff moved to 4a.
  - **4c — Chip and launcher end-state.** A1 + M2 render nothing while `creating`; the chip reaches its target end-state of error-only (resolved question 3). **Must land after 4a and 4b** — deleting the starting affordance while the tabs still require a manual warm leaves a blank surface with nothing explaining it, which trades a narration violation for a worse one.
  - **Native posture:** the web arm ships unflagged (the read tier is already live for tools); the native arm wires behind the existing `VITE_NATIVE_WORKING_COPY` flag and rewrites its stale comment to name the seven unsupported tools (finding 2). Flipping the default is a separate and *heavier* decision than the flag comment implies — a flag-on session loses the whole verification class (`run_tests`, `check_types`, `verify_workspace`) along with `exec`, `show_commit`, `download`, and `find_references`.
- **Wave 5 — the residue (scoped 2026-07-27).** Six rows that belong to no earlier wave, all open in code: C6 (status section collapses to one workspace row), C7 (manual snapshot absorbed by autosave + on-hide), C9 ("Fresh workspace" demoted to error-recovery-only, per resolved question 2), H1 (auto-retry; only terminal failure surfaces), I4 (transparent restart on expired session), J1 (wire native commit/push in the file browser; the copy dies with the gap). Plus two enforcement follow-ups:
  - **The Wave 1 lint pin has an uncovered channel.** Its property selector is `Property[key.name=/^(title|label|detail|description)$/]`, so `message:` is not pinned — and `sandbox-connectivity-notifications.ts` ships `message: 'Sandbox needs attention'` straight into `toast.error(...)` at `WorkspaceChatRoute.tsx`. Banned vocabulary reaching a user through a hole in the ban. Extend the selector and re-sweep; H1's own reword then rides its Wave 5 absorption.
  - **Move native diff sensitivity checks onto structured producer metadata.** The current `sanitizeNativeDiff` reparses formatted text and matches only the unquoted source-side path. Renames into a sensitive destination and C-quoted paths bypass block-level hiding. The fix is for the Kotlin producer to return structured `DiffEntry.oldPath` / `DiffEntry.newPath` metadata and for the sanitizer to decide from those fields, not to grow another diff-header parser. Executed counterexamples against the current sanitizer:

    ```text
    .env renamed to "dir b/file.txt"      → diff --git a/.env b/dir b/file.txt
       → block KEPT, "plain config body" rendered      (sensitive leak)
    safe.txt renamed to ".env b/file.txt" → diff --git a/safe.txt b/.env b/file.txt
       → block HIDDEN, "ordinary user work" lost       (false positive: hides real work)
    porcelain " M foo -> .env"            → whole status line dropped (false positive)
    ```

    Value-level secret redaction still applies, so this defense-in-depth failure degrades native diff protection to one layer; it is not an unconditional raw leak.

## Resolved questions (veto pass, 2026-07-26)

1. **Hibernate: delete outright.** Snapshot-on-hide + autosave cover the intent; no debug flag. C1/C2 verdicts confirmed as full deletions.
2. **"New Sandbox": error-recovery only.** "Fresh workspace" appears as a repair affordance when the workspace is in an error state, never as a standing control.
3. **Chip end-state: nothing at rest.** The chip renders only in the error state; starting/idle/reconnecting are invisible. Success is silence.
4. **"Workspace" confirmed as the user-facing noun** for the place. Wave 1 bakes it into every string; "sandbox" is banned from user-facing copy and a lint pin enforces the ban.
