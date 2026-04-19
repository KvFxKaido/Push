# useChat Regression Audit

**Date:** 2026-04-19
**Status:** Recon complete, no extractions performed
**Target:** `app/src/hooks/useChat.ts` (1,733 lines)
**Context:** The hook was refactored to completion on 2026-03-25 at 770 lines (`docs/archive/runbooks/useChat Refactor Plan.md`, target ~300–400). It has since regrown by ~963 lines. This doc audits what drove the regrowth, where each drifted feature should have landed, and what's needed before a re-extraction track can hold.

## Why this exists

The Architecture Remediation Plan (`Architecture Remediation Plan — Defusing the Big Four.md`, §"Containment rule for the deferred hooks") captured a specific risk Gemini named the "Waterbed Effect": complexity removed from the daemon or extracted from the hook gets pushed back up through dirty adapter code. The rule was *"No new policy logic in `useChat.ts` or `useAgentDelegation.ts`. They may compose context and callbacks; they must not learn new semantics."*

The rule wasn't enforced in PR review, and the hook grew back. This audit is the first concrete data we have on *how* it grew back and *why the existing siblings didn't absorb it* — which is the question any re-extraction track must answer before it writes a single line of code.

## Drift quantification

**Size:**
- 2026-03-25 (refactor complete): 770 lines
- 2026-04-19 (current): 1,733 lines
- **Net regrowth: +963 lines (+125%)**

**Top drift commits (useChat.ts line deltas since 2026-03-25):**

| Commit | Date | Net | Feature |
|---|---|---|---|
| `76471468` | 2026-03-30 | **+264** | Harness runtime evolution rollout (run-engine + journal + verification policy) |
| `a867ddfe` | 2026-03-30 | **+253** | Steerable runs + live console events |
| `5d0d56dd` | 2026-03-27 | **+223** | Persist queued followups + run events |
| `63cd4f95` | 2026-03-30 | +61 | Move verification enforcement into runtime |
| `795cd39e` | 2026-03-27 | +45 | Mobile persistence (visibility-based saving) |
| `9620b07c` | 2026-04-05 | +30 | Context memory invalidation |
| Smaller | various | ~+60 | Chat mode, fallback hardening, context-memory fail-open, CM async-safe |

Top three commits account for **+740 of the +876 semantic net additions** (≈85%). Targeting those three is the high-leverage move.

## What grew and where it lives in the hook

### Regrowth 1 — Harness runtime evolution (`76471468`, +264 net)

**Landed in useChat:**
- `runEngineStateRef` (line 316), `runJournalEntryRef` (line 317), `baseWorkspaceContextRef` (line 318), `verificationStateByChatRef` (line 544)
- `emitRunEngineEvent` useCallback (lines 633–718, **86 lines** — the largest single addition)
- Seven verification/workspace callbacks: `getVerificationPolicyForChat` (536), `getVerificationStateForChat` (546), `applyWorkspaceContext` (561), `persistRunJournal` (575), `persistVerificationState` (586), `updateVerificationStateForChat` (611), `setWorkspaceContext` (862), `setWorkspaceMode` (872)
- Run-engine initialization sequence in `sendMessage` at lines 1253–1299

**Sibling modules created by the same commit:**
- `lib/run-engine.ts` — exports `runEngineReducer` (pure reducer), `RunEngineState`, `IDLE_RUN_STATE`, `isRunActive`, `replayEvents`, `collectRunEngineParityIssues`
- `lib/run-journal.ts` — exports `createJournalEntry`, `appendJournalEvent`, `saveJournalEntry`, `loadJournalEntriesForChat`, etc. (14 functions)
- `lib/verification-policy.ts` — exports `resolveVerificationPolicy`, `getDefaultVerificationPolicy`

**Hospitability gap:** The new modules expose *primitives*, not a *coordinator*. The reducer lives in `run-engine.ts` but nobody owns the `useRef<RunEngineState>` + `dispatch` + journal-persistence wiring that turns the pure primitives into a usable service. `emitRunEngineEvent` is that coordinator — and it landed in useChat because there was no obvious module to host it.

### Regrowth 2 — Steerable runs + live console events (`a867ddfe`, +253 net)

**Landed in useChat:**
- `liveRunEventsByChat` state (254), `pendingSteersByChat` state (258)
- Their snapshot refs: `liveRunEventsByChatRef` (269), `pendingSteersByChatRef` (280)
- Replacers: `replaceLiveRunEvents` (374), `replacePendingSteers` (381)
- `appendRunEvent` useCallback (463–503, **40 lines** — routes events to live-only or persisted+journal based on `shouldPersistRunEvent`)
- Three steer callbacks: `setPendingSteer` (966), `consumePendingSteer` (976), `clearPendingSteer` (988)
- Steer-dispatch paths in `sendMessage`: lines 1105–1134 (mid-run steer), 1409–1446 (consume post-stream), 1492–1524 (consume post-tools), 1580–1592 (clear on chat switch)

**Sibling modules enhanced by the same commit:**
- `lib/chat-run-events.ts` — only +25 lines added (re-exports + trimming utilities). The commit grew the hook by 281 and the sibling by 25.

**Hospitability gap:** `chat-run-events.ts` is currently a thin re-export layer. There's no sibling that owns the "events can be live-only, persisted, or journaled; routing depends on event type" logic — that logic is `appendRunEvent` inside useChat. And there's no home at all for pending-steer state, despite the fact that `chat-queue.ts` already has a pattern for per-chat queued items.

### Regrowth 3 — Persist queued followups + run events (`5d0d56dd`, +223 net)

**Landed in useChat:**
- `queuedFollowUpsByChat` state (251), `journalRunEventsByChat` state (255), `queuedFollowUpsRef` (276)
- Five queue callbacks: `persistQueuedFollowUps` (904), `replaceQueuedFollowUps` (919), `enqueueQueuedFollowUp` (938), `dequeueQueuedFollowUp` (947), `clearQueuedFollowUps` (957)
- `hydratePersistedRunState` (999), two hydration effects: journal load (726–770), IndexedDB migration (1008–1020)
- Queue-dispatch in `sendMessage`: lines 1136–1154 (enqueue during active run), 1593–1607 (dequeue + auto-continue in finally)

**Sibling modules created/enhanced:**
- `hooks/chat-queue.ts` — pure immutable utilities only (`appendQueuedItem`, `shiftQueuedItem`, `clearQueuedItems`). No hook-level state management.
- `lib/chat-runtime-state.ts` — created with `build*ByChat` hydration helpers + immutable mutation helpers. Good surface, but only covers the "reading from/writing to conversation records" layer.

**Hospitability gap:** `chat-queue.ts` stopped at pure utils. Hook-level state management (the `useState<QueuedItemsByChat>` + the refs + the enqueue/dequeue callbacks with persistence) has no natural home — and lands in useChat.

## Classification of the drift

A pattern emerges: **every big regrowth commit added both a sibling and hook wiring. The sibling got the pure logic; the hook got the coordinator.**

| Feature | Pure logic lives in | Coordinator lives in |
|---|---|---|
| Run engine | `run-engine.ts` (reducer) | `useChat.ts` (86-line `emitRunEngineEvent`) |
| Run journal | `run-journal.ts` (14 functions) | `useChat.ts` (`persistRunJournal`, embedded in `emitRunEngineEvent`) |
| Verification policy | `verification-policy.ts` + `verification-runtime.ts` | `useChat.ts` (7 verification callbacks) |
| Live run events | `chat-run-events.ts` (trimming + persist predicate) | `useChat.ts` (40-line `appendRunEvent`) |
| Pending steers | — | `useChat.ts` (3 callbacks + 2 state/ref pairs) |
| Queued follow-ups | `chat-queue.ts` (3 pure utils) | `useChat.ts` (5 callbacks + state + ref) |

**The diagnosis:** the previous refactor extracted pure logic well. It did not extract *stateful coordinators*. When new features arrived, each had a pure-logic sibling to land in, but the stateful coordination layer had no pattern — so it landed in the hook by default. The containment rule was technically violated each time, but there was no obvious alternative landing spot.

This is not the useAgentDelegation pattern. useAgentDelegation had **no siblings at all** before Phase 1 — every extraction was net-new. useChat already had siblings; the question is **how to extend them (or add new ones) to absorb future coordinators.**

## Sibling hospitability — what each could absorb

| Sibling | Current shape | Drift it could absorb | Investment needed |
|---|---|---|---|
| `run-engine.ts` | Pure reducer + helpers | `runEngineStateRef`, much of `emitRunEngineEvent` | **New `useRunEngine(...)` hook** wrapping the reducer + journal wiring. Largest single-module investment. |
| `run-journal.ts` | 14 persistence primitives | `runJournalEntryRef`, `persistRunJournal`, journal-hydration effect | Expose a `useRunJournalCoordinator(...)` or fold into `useRunEngine`. Probably the latter — run-engine and journal are co-mutated. |
| `verification-policy.ts` / `verification-runtime.ts` | Pure resolvers + state helpers | All 7 verification callbacks + `verificationStateByChatRef` | New hook: `useVerificationState(...)`. Clear seam since verification is its own domain. |
| `chat-run-events.ts` | Thin re-export | `appendRunEvent` (routing logic) + `replaceLiveRunEvents` | Add a hook wrapper: `useRunEventStream(...)` — owns live+persisted+journal routing. |
| `chat-queue.ts` | 3 pure utils | All 5 queue callbacks + state + ref | Promote to a hook: `useQueuedFollowUps(...)`. Pattern can also absorb pending steers. |
| `chat-runtime-state.ts` | Hydration + mutation helpers | `hydratePersistedRunState`, IndexedDB migration effect | Already hospitable — move the hydration function + effect *into* it (or into the sibling that owns its data). |
| `chat-send.ts` | 2 async functions (stream, processTurn) | **Nothing more** — it's fine as-is | None. The `sendMessage` orchestrator itself probably doesn't extract further without the coordinators listed above landing first. |

**No sibling exists yet for:** pending steers (as a standalone concept) or the steer-dispatch logic inside `sendMessage`. These are the smallest genuinely-new seams.

## Proposed extraction track

The right shape is **4 phases**, each of which *extends or creates a coordinator hook* — not just moving functions into existing files. Phase ordering is by coupling hazard (lowest first).

### Phase 1 — `useQueuedFollowUps` hook (lowest risk)
- Promote `hooks/chat-queue.ts` to host a hook that owns `queuedFollowUpsByChat` state, the ref, and the 5 enqueue/dequeue/clear/persist/replace callbacks.
- Move the IndexedDB-migration portion that deals with queued followups into this hook's initialization.
- Hook surface: `useQueuedFollowUps(updateConversations) → { queuedFollowUpsByChat, queuedFollowUpsRef, enqueue, dequeue, clear, replaceAll, hydrate }`.
- **Removes ~130 lines from useChat.** Zero new semantics; just relocates what exists.
- **Risk:** Low. Queue ops are already pure-util-backed; this is just re-hosting the React state.

### Phase 2 — `useRunEventStream` hook
- Wrap `chat-run-events.ts` with a hook owning `liveRunEventsByChat`, `journalRunEventsByChat`, their refs, `replaceLiveRunEvents`, `appendRunEvent`.
- Handles the "live-only vs. persisted vs. journal" routing.
- Hook surface: `useRunEventStream({ updateConversations, persistRunJournal }) → { liveRunEventsByChat, journalRunEventsByChat, appendRunEvent, replaceLive, trimLive }`.
- **Removes ~100 lines from useChat.**
- **Risk:** Medium. `appendRunEvent` is called from many sites; its signature must not drift.

### Phase 3 — `useRunEngine` hook (highest-value, highest-risk)
- New hook in `run-engine.ts` (or a sibling `run-engine-hook.ts`) that owns `runEngineStateRef`, `runJournalEntryRef`, and the 86-line `emitRunEngineEvent` callback.
- Bundles journal persistence (`persistRunJournal`) since the two are always co-mutated.
- Hook surface: `useRunEngine({ updateConversations, appendRunEvent, getVerificationStateForChat }) → { runEngineStateRef, runJournalEntryRef, emitRunEngineEvent, isRunActive }`.
- **Removes ~180 lines from useChat.**
- **Risk:** High. This is the Track A cutover point for the harness runtime evolution. A bug here breaks all run-lifecycle semantics. Needs characterization tests before extraction (the run-engine unit tests in `run-engine.test.ts` cover the reducer in isolation, not the coordinator's effect sequencing).

### Phase 4 — `useVerificationState` hook + steer-dispatch helpers
Two smaller pieces that can ship together:
- `useVerificationState` owning `verificationStateByChatRef` + the 7 verification callbacks. Clean seam since verification is its own domain.
- Pending-steer state into `useQueuedFollowUps` (same pattern as follow-up queue) or into a new mini-hook. Probably the former — both are per-chat queued items.
- **Removes ~130 lines from useChat.**
- **Risk:** Low to medium. Verification is well-isolated; steer-dispatch inside `sendMessage` is the only non-trivial call site.

**Expected result after all 4 phases:**
- useChat: 1,733 → ~1,180 lines (−553) if Phase 4 ships in full.
- Still above the old ~400-line target because `sendMessage` at 534 lines is not directly attacked. That's deliberate: breaking up `sendMessage` was the old plan's Phase 4 and it explicitly chose to keep the orchestrator intact. This audit does not revisit that choice.
- To reach the 400-line target would require a Phase 5 that re-attempts `sendMessage` decomposition — a separate design question this audit does not answer.

## Sibling surface investments — what to build *first*

The extraction only holds if the siblings are hospitable *going forward*. A future feature must have an obvious landing spot **that isn't the hook**. The following investments make the containment rule enforceable:

1. **Every new hook extracted must export a `*HandlerContext`-like shape** matching the useAgentDelegation pattern. New features adding state/callbacks extend the context interface; the hook's dependency array tracks the helper, not every individual ref.
2. **The containment rule needs automation, not just documentation.** A simple ESLint rule or a pre-commit line-count warning on useChat.ts would catch regressions at PR time. Worth considering as part of Phase 1's delivery.
3. **The old plan's Phase 2 deferral — "helpers exist but not yet applied inline" — was the proximate cause of later regression.** Any hook extracted in this track should have its callers migrated in the same PR. No "helpers exist but hook still does it directly" half-states.

## Ordering and risk

**Recommended sequence:**
1. Phase 1 (queued follow-ups) first — cheapest, validates the "promote sibling to hook" pattern.
2. Phase 2 (run event stream) second — medium risk, enables Phase 3 (which depends on `appendRunEvent` being stable).
3. Phase 3 (run engine) third — highest risk, biggest payoff. Needs characterization tests as pre-req.
4. Phase 4 (verification + steers) last — cleanup; can be two separate PRs if risk warrants.

**Parallelization:** Phases 1 and 2 can be developed in parallel; Phase 3 must wait on Phase 2; Phase 4 can start anytime after Phase 1.

**Kill-switch:** after Phase 2, evaluate whether Phase 3's risk is warranted. If the hook is down to ~1,400 lines and feeling better, Phase 3 can be deferred — it's the only phase with meaningful rollback concern.

## Open questions

1. **Should `useRunEngine` and journal coordination be one hook or two?** The audit recommends one because the state is co-mutated (line 575 `persistRunJournal` is called from inside `emitRunEngineEvent` at line 633+). Two hooks would create an awkward "one must accept the other's state as a prop" coupling. Decide before Phase 3.
2. **Is Phase 4's steer + queue unification too clever?** Merging pending-steers into `useQueuedFollowUps` is structurally attractive but semantically weird — steers and follow-ups are different domain concepts that happen to share a per-chat-queue shape. Might be cleaner as separate hooks even at the cost of a tiny duplication.
3. **Does `sendMessage` decomposition belong in this track at all?** The old plan's Phase 4 shipped but the orchestrator is now 534 lines. This audit defers that decision but someone has to make it eventually — if Phase 3 lands and `sendMessage` is still 500+ lines, the hook's readability hasn't improved much.
4. **Should the containment rule be automated?** ~~An ESLint "max lines in useChat.ts" rule, or a pre-commit warning. Cheap to build, might prevent the next Waterbed Effect. Decide in Phase 1's PR.~~ **Resolved in Phase 1** — see "Phase 1 shipping record" below.

## What this audit deliberately does not include

- A detailed coupling map (which ref is read where). The useAgentDelegation recon needed that because every seam was new. For useChat, the three commits named above tell us *which seams grew* — the relevant coupling is internal to each extracted hook, not a global map. If a specific phase hits coupling surprises, re-recon that phase.
- Test-coverage matrix. `useChat.test.ts` is 308 lines; `useChatCheckpoint.test.ts` is 197. Each phase's characterization-test pre-requisite is a per-phase decision, not a global one. Phase 3 is the only phase where the audit flags a clear test-coverage gap.
- A Phase 5 for `sendMessage`. See Open Question #3.
- Any line counts for *ideal* future siblings. Those are design decisions that belong to the phase PR, not the recon.

## Phase 1 shipping record

**Date:** 2026-04-19
**Branch:** `refactor/usequeued-followups-hook`
**Commits:**
- `bdeb281` — `test(context): pin queued follow-ups hydration + abortStream seam`
- `b9d4833` — `refactor(context): extract useQueuedFollowUps hook from useChat`

**Line delta:** `app/src/hooks/useChat.ts` 1,733 → 1,672 (−61). Under the recon's 130-line estimate. The gap is deliberate, not a miss: the IndexedDB migration effect stayed in useChat because it coordinates `setConversationsLoaded` + active-chat resolution + `updateConversations`, none of which are queue-owned. Moving it into the new hook just to hit a number would have been fake neatness. The structural win — single ownership of queue state semantics and a persist-on-mutate invariant enforced by module boundary rather than locality — is the real payoff, not the shrink.

**Design adjustments from the recon:**

- Public hook surface is **4 callbacks, not 5**. `enqueue` / `dequeue` / `clear` / `hydrate` are exported; `persist` and `replace` stay internal. The recon listed all five because it enumerated current implementations. Exporting `replace` would have created a second mutation path that bypasses the persist-on-mutate contract, turning it from structure into convention. Internalizing both protects the invariant at the module boundary.
- Hook parameters include `dirtyConversationIdsRef` and `isMountedRef` alongside `updateConversations`. The recon mentioned only `updateConversations`; the other two are required by the existing persist/replace implementations (dirty-tracking for persistence, mount-gating for setState).
- The render-time `queuedFollowUpsRef.current = queuedFollowUpsByChat` sync line was removed from the extracted hook. Once every mutation routes through `replace` — which updates the ref *before* calling `setState` — the line is dead code. Removing it also avoids a `react-hooks/refs` lint error on the new file that the inline version in useChat never tripped (the rule is sensitive to how the ref is introduced).

**Test coverage approach:**

The fake-React harness in `useChat.test.ts` (no-op `useEffect`, cluster callbacks not on the returned surface) only lets characterization reach two paths from the outside: hydration via the constructor, and `abortStream({ clearQueuedFollowUps: true })`. Commit A pinned both. The `enqueue` / `dequeue` paths live inside `sendMessage`, which is not drivable through that harness. They are covered directly in Commit B's new `useQueuedFollowUps.test.ts` against the hook itself. This split — characterization at the consumer layer, direct invariant tests at the new hook — is the pattern Phase 2 and Phase 3 should follow; neither of those clusters is fully reachable from useChat's public API either.

**Incidental items:**

- `queuedFollowUpsRef` was added to the `abortStream` and `sendMessage` `useCallback` deps arrays. Post-extraction the ref comes from a hook destructure rather than an inline `useRef`, so `react-hooks/exhaustive-deps` can no longer statically infer stability. Adding the ref to deps is correct (it's a stable object) and silences the warning.
- Commit A added `updateAgentStatus`, `flushCheckpoint`, `checkpointRefs`, `lastCoderStateRef`, `tabLockIntervalRef` to the hoisted `chatCheckpoint` mock in `useChat.test.ts` so destructuring no longer yields `undefined` when an externally-called callback (like `abortStream`) reaches for `updateAgentStatus`. Future tests that drive other `useChatCheckpoint`-destructured callables inherit this fix.

**Open Question resolutions:**

- **#4: Automate the containment rule.** Resolved. `app/eslint.config.js` gains `'max-lines': ['error', { max: 1700 }]` scoped to `src/hooks/useChat.ts`. Current file is 1,672 lines; threshold gives ~30 lines of headroom for maintenance churn and blocks silent regrowth. Ratchet down as Phases 2-4 land (suggested next thresholds: 1,580 after Phase 2, 1,400 after Phase 3, 1,250 after Phase 4 — these are aspirational and each phase's PR should finalize its own target).

**Open questions still unresolved:** #1 (one-vs-two hooks for run-engine+journal, Phase 3 decision), #2 (steer+queue unification, Phase 4 decision), #3 (`sendMessage` decomposition, deferred indefinitely).

**Status:** Phase 1 ready for PR. Phase 2 (`useRunEventStream`) can start in parallel; Phase 3 is blocked on Phase 2 landing; Phase 4 can start anytime after Phase 1.

## Phase 2 shipping record

**Date:** 2026-04-19
**Branch:** `refactor/userunevent-stream-hook`
**Commits:**
- `5a4983c` — `test(context): pin run-events UI merge-order invariant`
- `bd4be63` — `refactor(context): extract useRunEventStream hook from useChat`

**Line delta:** `app/src/hooks/useChat.ts` 1,673 → 1,577 (−96). Matches the recon's 85-90 estimate. The `runEvents` UI useMemo and `activePersistedRunEventCount` derivation stayed in useChat for the same reason Phase 1's IDB migration did: they read `activeConversation` from conversations state, which isn't hook-owned.

**Design adjustments from the recon:**

- Public hook surface is **3 items, not 5**. `liveRunEventsByChat` / `journalRunEventsByChat` / `appendRunEvent` are exported; `replaceLiveRunEvents` and `liveRunEventsByChatRef` stay internal. Same structural reasoning as Phase 1 — every mutation routes through the coordinator (`appendRunEvent`), and exposing `replaceLive` would create a second mutation path that bypasses the trim + persist-routing contract.
- `runJournalEntryRef` flows in as a hook parameter rather than `persistRunJournal` as the recon suggested. Current `appendRunEvent` calls `saveJournalEntry(runJournalEntryRef.current)` directly; passing the ref matches that one-to-one without requiring a re-plumbing. When Phase 3 lands, `useRunEngine` will own the ref and hand it to this hook — the parameter stays, the owner changes.
- Journal-load `useEffect` moved into the hook. Its inputs (`activeChatId`, `activePersistedRunEventCount`) flow as params; its sole write-target (`journalRunEventsByChat`) is already hook-owned. Clean fit.
- The synchronous clearing branch inside the journal-load effect (lines 729-736 in the old useChat) was dead code. useChat's `runEvents` useMemo short-circuits `persisted ?? journal ?? []`, so clearing `journalRunEventsByChat[activeChatId]` when persisted events took over had no user-visible effect. The `react-hooks/set-state-in-effect` rule caught it; the extracted hook drops the branch. The stale slot is inert until the chat's count returns to zero, at which point the load branch refreshes it.

**Test coverage approach:**

The characterization tests in `useChat.test.ts` pin the UI merge-order invariant (`mergeRunEventStreams` arg order, the `?? []` fallback, identity of the useMemo return). The direct unit tests in `useRunEventStream.test.ts` cover the three `appendRunEvent` branches (live-only, persisted-no-journal, persisted+journal), the `subagent.completed` → `recordDelegationOutcome` subpath, id/timestamp stamping, and trim ordering. The journal-load effect is **not** covered at the unit level: the fake-React harness's no-op `useEffect` plus the async `loadJournalEntriesForChat` promise chain cannot be modeled without a full renderer. Integration coverage handles it; this matches the Phase 1 pattern of acknowledging harness limits explicitly.

**Open Question resolutions:**

- **#1 (one-vs-two hooks for run-engine + journal, Phase 3 decision):** Still open, but Phase 2's shape constrains it. `useRunEventStream` now takes `runJournalEntryRef` as a param, which means Phase 3's `useRunEngine` must *expose* that ref in its return interface. That nudges toward a single `useRunEngine` hook that owns both the engine state and the journal entry, since a caller of Phase 3 (useChat) would otherwise have to thread two refs into Phase 2. Not a forced decision, but the Phase 3 design should start from that default.

**Open questions still unresolved:** #1 (one-vs-two, Phase 3 decision), #2 (steer + queue unification, Phase 4 decision), #3 (`sendMessage` decomposition, deferred indefinitely).

**Containment guard ratcheted:** `eslint.config.js` lowered `max-lines` from 1,700 to 1,620. Current file is 1,577 lines; ~40 lines of headroom. History table added to the rule's comment so future ratchets have context.

**Status:** Phase 2 ready for PR. Phase 3 (`useRunEngine`) is unblocked — `appendRunEvent` stability is verified and its dependency shape is now explicit. Phase 4 remains independent of Phases 2 and 3.

---

**Generated:** 2026-04-19, recon-only pass. No extractions performed. The three regrowth commits have been analyzed, sibling hospitability has been assessed, and a four-phase extraction track has been proposed.

**Updated:** 2026-04-19, Phase 1 shipping record added following the landing of `bdeb281` + `b9d4833` on `refactor/usequeued-followups-hook`.

**Updated:** 2026-04-19, Phase 2 shipping record added following the landing of `5a4983c` + `bd4be63` on `refactor/userunevent-stream-hook`.
