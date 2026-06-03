/**
 * Delegation-mode preference — the step-1 lever for the Coder Delegation
 * Collapse track (see `docs/decisions/Coder Delegation Collapse —
 * Component Audit.md`, sequencing step 1, and the paired `Main as
 * Scratchpad — Branch on Graduation.md`).
 *
 * Two modes, A/B-comparable, with the delegated arc kept intact:
 *
 *   - `delegated` (default) — the historical path. The Orchestrator runs
 *     its turn in the foreground loop and, when it decides to edit,
 *     emits `delegate_coder` → optional Planner pre-pass → synthesized
 *     brief → `runCoderAgent` → Auditor.
 *   - `inline` — the single-agent collapse. The user's raw turn is run
 *     directly by the durable job engine (`startMainChatJob`) with NO
 *     Orchestrator handoff, NO Planner, and NO synthesized brief. This
 *     reuses the exact engine the background-mode path already exercises
 *     (`chat-send-background.ts` → `startMainChatJob` → CoderJob DO); the
 *     audit's premise is that this engine is separable from the
 *     delegation wrapper, and step 1 proves it behind a flag before any
 *     deletion.
 *
 * ## Relationship to background-mode (deliberately decoupled framing)
 *
 * `background-mode-settings.ts` and this module currently converge on the
 * same runtime route — both send the raw turn to the durable engine via
 * `startBackgroundMainChatTurn`. They are kept as *separate inputs*
 * on purpose:
 *
 *   - background-mode is framed as "run this turn detached" (a UX/runtime
 *     property — the turn surfaces via JobCard, never enters apiMessages).
 *   - delegation-mode `inline` is framed as "collapse the delegation
 *     wrapper" (an architecture experiment — measure the single-agent loop
 *     against the delegated arc).
 *
 * They share a mechanism today but answer different questions, so the
 * route decision (`shouldRouteTurnToEngine`) treats them as an OR of two
 * named triggers rather than one flag. Either being on routes the turn to
 * the engine; the measurement log records *which* trigger fired so the
 * before-deleting gate can tell collapse-experiment turns apart from
 * plain detached sends.
 *
 * Storage key mirrors the background-mode naming convention (a mode
 * *preference*, not a permanent capability) so a future per-chat override
 * can layer in without a contract change — callers read through
 * `getDelegationMode()` / `useDelegationMode()` and a per-chat lookup
 * would short-circuit before reaching the global.
 */

import { useEffect, useState } from 'react';
import { isBackgroundModeEnabled } from './background-mode-settings';
import { safeStorageGet, safeStorageSet } from './safe-storage';

export type DelegationMode = 'delegated' | 'inline';

const STORAGE_KEY = 'push:delegation-mode-preference';
const CHANGE_EVENT = 'push:delegation-mode-changed';

export function getDelegationMode(): DelegationMode {
  return safeStorageGet(STORAGE_KEY) === 'inline' ? 'inline' : 'delegated';
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
 * The two non-null ways a turn bypasses the Orchestrator and runs on the
 * durable engine. Exported on its own so `chat-send-background.ts` types
 * its forwarded `engineTrigger` from this single source rather than
 * re-declaring the union (which would drift if a third trigger lands —
 * Copilot review, PR #773).
 */
export type EngineTrigger = 'inline-delegation' | 'background-mode';

/**
 * The named trigger that caused a turn to route to the durable engine,
 * or `null` when the turn stays on the foreground Orchestrator loop.
 * `inline-delegation` wins precedence over `background-mode` for the
 * measurement label when both are on — the collapse experiment is the
 * more specific intent.
 */
export type TurnEngineTrigger = EngineTrigger | null;

/**
 * Single source of truth for "does this turn bypass the Orchestrator and
 * run on the durable engine?". Reads both named triggers so the routing
 * decision is centralized — callers never re-derive the OR. Returns the
 * winning trigger (or `null` for the Orchestrator loop) so the caller can
 * both branch and label its measurement log from one value.
 *
 * Attachments force the Orchestrator loop regardless of flags: the
 * background/engine envelope does not carry attachments yet (see
 * `useChat.sendMessage`'s `!hasAttachments` guard, which this subsumes).
 */
export function resolveTurnEngineTrigger(opts: { hasAttachments: boolean }): TurnEngineTrigger {
  if (opts.hasAttachments) return null;
  if (isInlineDelegationEnabled()) return 'inline-delegation';
  if (isBackgroundModeEnabled()) return 'background-mode';
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
