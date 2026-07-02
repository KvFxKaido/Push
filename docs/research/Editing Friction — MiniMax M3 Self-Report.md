# Editing Friction — MiniMax M3 Self-Report

> Research compiled 2026-07-02. Source: a MiniMax M3 session on the web surface,
> asked afterwards to describe the editing friction it hit. Same genre as the
> archived [`Harness Friction — Agent Self-Report.md`](../archive/decisions/Harness%20Friction%20—%20Agent%20Self-Report.md)
> (Claude/Gemini/Codex, 2026-03) — an agent's-eye view of the harness, mapped to
> what the runtime actually does today.
>
> This is research, not an operating decision. The live contracts are
> [`../decisions/Agent Runtime Decisions.md`](<../decisions/Agent Runtime Decisions.md>) and
> [`../decisions/Platform, Sessions, and Sandbox Decisions.md`](<../decisions/Platform,%20Sessions,%20and%20Sandbox%20Decisions.md>);
> the Gate-at-Push delivery model is
> [`../decisions/Pushed Branch as Source of Truth — Gate at Push.md`](<../decisions/Pushed%20Branch%20as%20Source%20of%20Truth%20—%20Gate%20at%20Push.md>).

Each item below was verified against the code before recording. Several of
M3's asks are **already shipped** and the friction was a discoverability or
prompt-teaching problem, not a missing capability — that finding matters as
much as the genuine gaps, because it means the fix is per-provider teaching
(see [`../decisions/Per-Provider Role Routing Presets.md`](<../decisions/Per-Provider%20Role%20Routing%20Presets.md>)),
not new tools.

---

## Tool-flow friction

### 1. "Did I actually commit?" false negative

**Report:** M3 committed locally, then reported "no code changes" to the user
because it never saw a push tool result come back — it conflated a silent
round-trip with failure, and only in hindsight noted it should have checked
local state before claiming nothing landed.

**Push status (verified):** The signals exist but are split across channels.
`sandbox_commit` returns a real tool result ending "Use prepare_push to ship."
(`app/src/lib/sandbox-git-release-handlers.ts` `handleSandboxCommit`). The
approval-gated push path never returns a *tool result* — the push executes in
the UI action handler and the model gets an injected synthetic message
(`Pushed to the remote.`, `app/src/hooks/chat-card-actions.ts`). If the model's
turn ends before the user approves, there is a window where the model has
committed, staged a push, and heard nothing — which is exactly the state M3
misread as "nothing landed."

**Assessment:** Claim accurate as a confusion report, but the root cause is
the asymmetry between tool-result confirmation (commit) and synthetic-message
confirmation (approved push), not a missing signal. The `[pulse]` line
(item 2) already tells the model its commit landed locally.

**Follow-up:** Consider a "push pending approval" acknowledgement in the
`prepare_push` result that names the exact state ("committed locally at
`<sha>`; push staged, awaiting approval — do NOT report this as un-landed"),
so a model that ends its turn there describes reality.

### 2. Three round-trips to ship (`commit` → `prepare_push` → approve → `push`)

**Report:** Commit, then stage the push, then user approval, then `push()`
re-runs the gate on retry — three round-trips for what feels like one action.
M3's #1 ask: a single-step `commit_and_push` with the Auditor gated inline.

**Push status (verified):** Accurate on the round-trip count; one correction
to M3's telling. There is no single-step path: `sandbox_commit` is a silent
local commit and `prepare_push` audits the cumulative diff and returns a
review card that "does NOT push on its own"
(`app/src/lib/sandbox-tools.ts` dispatch arms;
`sandbox-git-release-handlers.ts`). But approving the card does **not**
call `sandbox_push` or re-run the Auditor — the approval handler pushes
directly and re-runs only the cheap deterministic gates (Protect Main +
secret scan), deliberately, so an already-approved SAFE verdict can't flip
(`app/src/hooks/chat-card-actions.ts`). `sandbox_push` is the *direct* arm
that bypasses `prepare_push`, and only there does the push-time Auditor gate
run. M3's "push() re-runs the gate" describes the direct-retry path, not the
approval flow.

**Assessment:** The round-trip count is real, but the split is the
**Gate-at-Push design, not an accident** — the silent local commit exists
precisely so the Auditor reviews one cumulative push diff instead of N commit
diffs, and the approval card is the sole human checkpoint. A fused
`commit_and_push` that preserved the gate would collapse only one round-trip
(commit + prepare), not the approval itself.

**Follow-up:** A `prepare_push` flag (or tolerant behavior) that commits any
dirty working tree first — same Auditor gate, same card, one fewer tool call.
Worth weighing against the value of the commit message as a distinct
model-authored artifact.

### 3. Read-tier ambiguity during fix loops

**Report:** `repo_read` / `repo_search` serve the last-pushed state, so during
an edit-then-verify loop M3 was unsure whether reads would see its local
edits; it wanted the active branch + "working tree differs from origin"
surfaced in tool results.

**Push status (verified):** Mostly shipped. The tier split is taught in the
protocol text ("READ TIER … last pushed state … reach for the sandbox read
tools only when you need uncommitted working-tree changes,"
`app/src/lib/github-tool-protocol.ts`) and the orchestrator prompt; read-tier
fallbacks are annotated in-band (`app/src/lib/web-tool-execution-runtime.ts`).
Every tool result already carries a `[meta]` line with `dirty=<bool> files=<N>`
and mutations append a `[pulse]` line with `{branch, head, dirty, files,
changedFiles}` (`app/src/lib/chat-tool-messages.ts`).

**Assessment:** The asked-for indicator substantially exists; M3 either did
not weight it or its session predated the pulse. The one true gap: the pulse
reports dirty-vs-HEAD, **not ahead/behind-vs-origin** — "how far is local
state from what `repo_read` serves" is genuinely not surfaced anywhere.

**Follow-up:** Add ahead-of-origin (unpushed commit count) to the pulse
payload. That is the number that actually answers "will `repo_read` see my
work?"

---

## Sandbox-edit friction

### 4. Whole-patch rejection feels opaque

**Report:** When one patchset entry fails validation, the whole patch is
rejected; M3 wanted "this entry failed because of X, the other 3 are still
staged."

**Push status (verified):** Half stale. Rejection is all-or-nothing by design
(Phase-1 validation, nothing written on failure), but the diagnostics already
do what M3 asks: the `EDIT_HASH_MISMATCH` detail names the failing entry per
path with per-op errors plus same-line retry hints from
`buildHashlineRetryHints`, and states "No changes were written"
(`app/src/lib/sandbox-write-handlers.ts` Phase 1;
`app/src/lib/sandbox-edit-ops.ts`).

**Assessment:** "Keep the other entries staged" would break patchset
atomicity — the transactional all-or-nothing contract is the point (it was
the Codex #6 ask in the 2026-03 report). The actionable reading is that the
resubmit still costs a full re-issue of every entry, including the valid
ones.

**Follow-up:** None structural. If this recurs across providers, the cheap
option is a resubmit affordance ("re-send only the corrected entry; the
validated entries are replayed from the previous call") — but that is a
protocol change and needs more than one data point.

### 5. `edit` vs `edit_range` vs `replace` boundary is fuzzy

**Report:** M3 overused `edit_range` when `replace` would have been cleaner
and vice versa; asked for a one-line "use `replace` when you can name a
unique substring" hint at the call site.

**Push status (verified):** Already shipped, nearly verbatim. The tool
descriptions carry exactly this guidance — replace: "Best for targeted
one-line edits when you can name a distinctive string without knowing the
hash"; edit: "Prefer EDIT_RANGE for contiguous block replacements; use EDIT
for surgical anchored edits and multi-point changes"
(`app/src/lib/sandbox-tool-detection.ts`).

**Assessment:** Capability exists; M3 didn't internalize it. This is a
per-provider teaching signal, not a harness gap.

### 6. Stale `expected_version` mid-patch costs a re-read

**Report:** Stale version errors mean re-reading the file for fresh hashes —
an extra call. M3 asked for auto-refreshed versions on adjacent same-turn
edits.

**Push status (verified):** Split by failure mode. Hashline-anchor mismatches
are already self-healing: an auto-retry re-locates content by hash without
the model acting, and on failure the error embeds fresh same-line retry
hashes (`app/src/lib/sandbox-edit-handlers.ts`,
`sandbox-edit-ops.ts` `buildHashlineRetryHints`). The whole-file `STALE_FILE`
write rejection is the real case: it returns only `expected=<v> current=<v>`
and instructs a re-read — no fresh hashes.

**Assessment:** Claim is accurate only for the `STALE_FILE` path.

**Follow-up:** Attach refreshed hashline anchors for the affected span (or
the current file version plus changed-region hashes) to `STALE_FILE` errors,
mirroring what the hashline-mismatch path already does. This is the
"mutation results should carry postconditions" principle from the 2026-03
report applied to the *error* channel.

---

## Git state / branch friction

### 7. No branch rename path

**Report:** Renaming a branch while keeping history required commit → create
new branch at the same commit → push; the old name lingers.

**Push status (verified):** Accurate that no typed rename exists —
`create_branch` / `switch_branch` are the only branch tools
(`app/src/lib/sandbox-tools.ts`). But raw `git branch -m` is **not** blocked:
`classifyGitCommand` special-cases only `checkout`/`switch` (and remote
mutations); `branch` falls through to the default allow-mutate arm
(`lib/git/policy.ts` `classifySegment`), so `sandbox_exec` will run a rename
today. That is the opposite of a safe recipe — renaming the current branch
out from under Push desyncs the tracked branch (`conv.branch`, upstream,
any open PR base) with none of the sync the typed tools provide.

**Assessment:** Two gaps, not one: the missing capability (no typed rename)
and an unguarded desync path (`git branch -m` passes the exec policy). The
second is the same state-sync class that motivated blocking bare
`checkout`/`switch`, and it's the more urgent half.

**Follow-up:** Route or block `git branch -m/-M/--move` in
`lib/git/policy.ts` (same treatment as `checkout`/`switch`); then either a
typed `rename_branch` tool or document create-at-same-commit + delete-old as
the supported recipe. Triage the tool by observed demand; the policy gap
shouldn't wait for it.

### 8. Push-complete signal with CI status

**Report:** CI after push is fire-and-forget; M3 wanted the next turn to
start from "push landed, here's CI" facts instead of narrated predictions.

**Push status (verified):** Mostly shipped on the approval path: after an
approved push the runtime injects "Pushed to the remote." and, 3 seconds
later, auto-runs `fetch_checks(ref: HEAD)` and injects a "CI status after
push:" message (`app/src/hooks/chat-card-actions.ts`). The model can also
call `fetch_checks` itself at any time (`lib/github-tool-core.ts`). Two gaps
remain: a **direct** `sandbox_push` returns only "Pushed successfully." with
no CI attached, and the injected CI details ride primarily in the UI
`ci-status` card — the model-visible text is thinner than what the user sees.

**Follow-up:** Parity for the direct-push arm (append the same auto-check),
and consider putting a compact machine-readable check summary in the injected
message body, not just the card.

---

## Synthesis

| # | M3 ask | Verdict | Action |
|---|---|---|---|
| 1 | Commit-landed clarity | Signal exists, channel asymmetric | "Push staged, awaiting approval" state named in `prepare_push` result |
| 2 | Single-step commit-and-push | Real, but the split is the Gate-at-Push design | Optional commit-dirty-tree-first behavior on `prepare_push` |
| 3 | Branch + dirty in tool results | Shipped (`[meta]`/`[pulse]`) | Add ahead-of-origin count to pulse |
| 4 | Patch partial-failure diagnostics | Diagnostics already per-entry; atomicity is intentional | None (watch for recurrence) |
| 5 | edit/edit_range/replace hint | Shipped verbatim | None — provider teaching signal |
| 6 | Auto-refresh stale versions | Shipped for hashline mismatch; gap on `STALE_FILE` | Fresh anchors in `STALE_FILE` errors |
| 7 | Branch rename | No typed rename — and `git branch -m` passes the exec policy (desync gap) | Route/block `branch -m` in `lib/git/policy.ts`; typed `rename_branch` demand-triaged |
| 8 | Push-complete + CI signal | Shipped on approval path | Direct-push parity + richer model-visible check summary |

Two meta-observations:

- **Half the report is discoverability, not capability** (items 3, 5, 8, and
  partially 6). The pulse, the edit-tool guidance, and the post-approval CI
  injection all existed and went unused or unnoticed. Before adding surface
  area, check whether the per-provider prompt presets should weight these
  affordances harder for models that miss them.
- **The genuine gaps cluster on the error/edge channel**, echoing the 2026-03
  synthesis ("mutation results are too thin"): `STALE_FILE` errors without
  fresh anchors, direct-push results without CI, `prepare_push` results that
  don't name the awaiting-approval state. The happy path is well-instrumented;
  the recovery paths still make the model re-derive state.
