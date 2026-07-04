/**
 * Delegation-mode preference — the step-1 lever for the Coder Delegation
 * Collapse track (see `docs/decisions/Coder Delegation Collapse —
 * Component Audit.md`, sequencing step 1, and the paired `Main as
 * Scratchpad — Branch on Graduation.md`).
 *
 * Two modes, A/B-comparable, with the delegated arc kept intact:
 *
 *   - `inline` (default since 2026-06-11) — the single-agent collapse. The
 *     user's raw turn runs the coder kernel directly with NO Orchestrator
 *     handoff, NO Planner, and NO synthesized brief. Originally (#887)
 *     this routed to the durable job engine; since the Inline Foreground
 *     Lane it runs **in the browser as the lead agent**
 *     (`chat-send-inline.ts`), streaming into the chat transcript and
 *     registered with RunHost so silence → adoption keeps it durable —
 *     "local while watched". The engine route remains reachable via the
 *     explicit background-mode toggle. Step 1 proved the collapse behind
 *     a flag before the flip: the A/B measured twice (v1 + v2 on fixed
 *     instruments) with quality tied and the wrapper costing ~78%
 *     wall-clock plus a unique dead-handoff failure mode.
 *   - `delegated` (opt-out) — the historical wrapper arc, retained until
 *     the Planner/brief deletion lands. The Orchestrator runs its turn in
 *     the foreground loop and, when it decides to edit, emits
 *     `delegate_coder` → optional Planner pre-pass → synthesized brief →
 *     `runCoderAgent` → Auditor. Attachment turns can now ride either bypass
 *     route because the inline lane and background engine envelope both carry
 *     the current turn's multipart content into the shared Coder kernel.
 *
 * ## Relationship to background-mode (deliberately decoupled framing)
 *
 * `background-mode-settings.ts` and this module are *separate inputs* on
 * purpose, and since the Inline Foreground Lane they route to separate
 * runtimes:
 *
 *   - background-mode is framed as "run this turn detached" (a UX/runtime
 *     property — the turn surfaces via JobCard, never enters apiMessages)
 *     and keeps the CoderJob DO engine route.
 *   - delegation-mode `inline` is framed as "collapse the delegation
 *     wrapper" (an architecture decision — single-agent loop, no
 *     Orchestrator handoff) and runs the kernel in the foreground.
 *
 * The route decision (`resolveTurnEngineTrigger`) stays centralized so
 * callers never re-derive the precedence; the measurement logs record
 * which trigger fired so the arcs stay A/B-comparable.
 *
 * Storage key mirrors the background-mode naming convention (a mode
 * *preference*, not a permanent capability) so a future per-chat override
 * can layer in without a contract change — callers read through
 * `getDelegationMode()` / `useDelegationMode()` and a per-chat lookup
 * would short-circuit before reaching the global.
 */

import { useEffect, useState } from 'react';
import { resolveDelegationMode, type DelegationMode } from '@push/lib/delegation-mode';
import { isBackgroundModeEnabled } from './background-mode-settings';
import { safeStorageGet, safeStorageSet } from './safe-storage';

// 2026-06-11 (Inline Foreground Lane): `inline` no longer routes to the
// durable engine. The trigger vocabulary below is unchanged, but the two
// triggers now name two different RUNTIMES: `background-mode` keeps the
// CoderJob DO engine + JobCard; `inline-delegation` dispatches to the
// foreground inline lane (`chat-send-inline.ts`) — the coder kernel running
// in the browser as the lead agent, streaming into the chat transcript.
// Precedence also inverted: background-mode (explicit detach) now wins over
// inline when both are on, because detaching is the more specific intent
// (decision doc, open question 3).

// The mode vocabulary and the "only an exact 'delegated' opts back in"
// rule live in the shared module so the CLI's PUSH_DELEGATION_MODE
// resolution can't drift from the web preference (Agent Runtime
// Decisions §10 convergence).
export type { DelegationMode } from '@push/lib/delegation-mode';

const STORAGE_KEY = 'push:delegation-mode-preference';
const CHANGE_EVENT = 'push:delegation-mode-changed';

export function getDelegationMode(): DelegationMode {
  // Inline is the default since 2026-06-11 — the step-1 measurement gate
  // was met twice (v1 + v2 A/B; see the Delegation-collapse A/B section in
  // `docs/decisions/Durable Runs — Adopt-on-Silence.md`).
  return resolveDelegationMode(safeStorageGet(STORAGE_KEY));
}

export function isInlineDelegationEnabled(): boolean {
  return getDelegationMode() === 'inline';
}

export function setDelegationMode(mode: DelegationMode): void {
  safeStorageSet(STORAGE_KEY, mode);
  // Notify same-tab listeners — `storage` events only fire cross-tab.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
}

/**
 * The two non-null ways a turn bypasses the Orchestrator wrapper. Exported
 * on its own so `chat-send-background.ts` types its forwarded
 * `engineTrigger` from this single source rather than re-declaring the
 * union (which would drift if a third trigger lands — Copilot review, PR
 * #773). Since the Inline Foreground Lane, only `background-mode` is an
 * engine route; `inline-delegation` names the foreground inline lane.
 */
export type EngineTrigger = 'inline-delegation' | 'background-mode';

/**
 * The named trigger that bypasses the Orchestrator wrapper for this turn,
 * or `null` when the turn stays on the foreground Orchestrator loop.
 * `background-mode` wins precedence over `inline-delegation` when both are
 * on — explicit detach is the more specific intent now that the two
 * triggers route to different runtimes (inverts the pre-lane precedence,
 * which only picked the measurement label; decision doc open question 3).
 */
export type TurnEngineTrigger = EngineTrigger | null;

/**
 * Single source of truth for the turn dispatch table (decision doc,
 * §"Decision"):
 *
 *   | Turn shape                                   | Route                       |
 *   |----------------------------------------------|-----------------------------|
 *   | `background-mode` on, engine-eligible        | CoderJob DO engine + JobCard|
 *   | `inline` mode (default), repo+branch         | Foreground inline lane      |
 *   | No-repo workspaces                           | Foreground Orchestrator loop|
 *   | `delegated` opt-out                          | Foreground Orchestrator loop|
 *
 * Attachments do not affect this route decision; both bypass routes carry
 * current-turn attachments as multipart content into the Coder kernel.
 *
 * The two eligibility flags are the caller's word that each route's
 * preconditions are satisfiable, and they differ deliberately:
 *
 *   - `engineEligible` — repo + branch + an engine-capable provider.
 *     Engine turns run server-side where only Worker-held or user-stored
 *     server-side keys exist (#889/#890), so a Settings-key-only provider
 *     must not detach.
 *   - `inlineEligible` — repo + branch only. The inline lane is a
 *     foreground run: browser-held Settings keys work directly, so the
 *     provider-capability fold does NOT apply (the gate moved to
 *     background-mode and adoption only). No-repo workspaces (scratch /
 *     chat) fall through to the Orchestrator loop that serves
 *     them fine (Codex P1, PR #887).
 */
export function resolveTurnEngineTrigger(opts: {
  engineEligible: boolean;
  inlineEligible: boolean;
}): TurnEngineTrigger {
  if (isBackgroundModeEnabled() && opts.engineEligible) return 'background-mode';
  if (isInlineDelegationEnabled() && opts.inlineEligible) return 'inline-delegation';
  // LOAD-BEARING: `null` routes to the foreground Orchestrator role/loop, which
  // is still the live path for (1) no-repo workspaces (chat / scratch —
  // never inline-eligible) and (2) the explicit `delegated` opt-out.
  // The Orchestrator prompt is assembled at runtime via
  // `buildOrchestratorBaseBuilder` in orchestrator.ts. Do NOT prune the
  // Orchestrator role, its prompt builder, or this branch as "legacy" while
  // either trigger exists — only the Orchestrator→Coder *wrapper* arc is
  // slated for deletion (decision doc §10), not the lead loop itself.
  return null;
}

/**
 * The two arcs are measured at their own seams rather than at a redundant
 * turn-level log: the engine arc emits `delegation_engine_job_started`
 * (with `trigger`) from `chat-send-background.ts` and the CoderJob DO's
 * own `coder_job_*` lines carry its latency/quality; the delegated arc
 * emits
 * `coder_delegation_measured` from `coder-delegation-handler.ts`. Together
 * those give the step-1 A/B its latency + quality data.
 */
export function useDelegationMode(): [DelegationMode, (next: DelegationMode) => void] {
  const [mode, setMode] = useState<DelegationMode>(() => getDelegationMode());

  useEffect(() => {
    const sync = () => setMode(getDelegationMode());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setter = (next: DelegationMode) => {
    setDelegationMode(next);
    setMode(next);
  };

  return [mode, setter];
}
