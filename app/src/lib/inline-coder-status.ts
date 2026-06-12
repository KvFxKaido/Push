/**
 * inline-coder-status.ts — presentation seam for the inline lane's spinner.
 *
 * The coder kernel reports progress through `onStatus(phase, detail)` using
 * *internal* vocabulary — "Coder working...", "Coder executing...", "Coder
 * reasoning", "Coder loop", and so on (see the `callbacks.onStatus(...)`
 * calls in `lib/coder-agent.ts`). Before the inline foreground lane, those
 * never reached the main chat spinner: the Orchestrator drove it with vibe
 * verbs + "Responding..." and coder work lived in a separate card. Now the
 * kernel is the lead, so the lane must translate its signals into the same
 * phase-first vocabulary the rest of the UI uses (`lib/role-display.ts`) and
 * never forward a raw "Coder X" string to users.
 *
 * Active work reads phase-first (Editing / Exploring / Verifying); the dead
 * air between rounds (round start, reasoning, loop, resume, checkpoint) is
 * "thinking", which the caller renders as a rotating themed verb.
 */

import { getRoleDisplay } from '@push/lib/role-display';

// Phase-first labels sourced from the display seam — never hand-spelled (the
// `?? …` only guards the `string | null` shape; these roles always have a
// phase today).
const EDITING = getRoleDisplay('coder').phase ?? 'Editing';
const EXPLORING = getRoleDisplay('explorer').phase ?? 'Exploring';
const VERIFYING = getRoleDisplay('auditor').phase ?? 'Verifying';

export interface InlineStatusRender {
  /** User-facing phase label. When `thinking` is true this is a static
   *  fallback (e.g. for the event log); the bar shows a rotating verb. */
  phase: string;
  /** Secondary text (tool summary / criterion) carried from the kernel. */
  detail?: string;
  /** True → "dead air" between visible work; the caller attaches the themed
   *  vibe-verb pool so the spinner rotates rather than showing a label. */
  thinking: boolean;
}

/**
 * Best-effort cosmetic split of a tool-execution round into exploration
 * (read-only) vs editing, off the kernel's own status detail — the batch
 * label ("N parallel reads + M mutations") or a single tool name. A wrong
 * guess only mislabels the spinner, never behavior, so this stays a
 * heuristic rather than a coupled tool-capability lookup.
 */
function executingPhase(detail?: string): string {
  if (!detail) return EDITING;
  const d = detail.toLowerCase().trim();
  // Batch label ("N parallel reads + M mutations") — mutations win.
  if (d.includes('mutation')) return EDITING;
  if (d.includes('read')) return EXPLORING;
  // Single tool name: read-only inspection verbs read as exploration. Covers
  // the GitHub PR/CI tools the lead gained in #895 (fetch_pr / list_prs /
  // get_workflow_runs / check_pr_mergeable / find_existing_pr) — none of
  // which contain "read" — alongside grep/ls/glob/cat.
  if (/^(fetch|list|get|check|find|search|view|show|grep|glob|ls|cat|inspect)([_\s-]|$)/.test(d))
    return EXPLORING;
  return EDITING;
}

/**
 * Translate a raw coder-kernel `onStatus(phase, detail)` signal into
 * user-facing spinner vocabulary.
 *
 * Only the kernel's *internal* vocabulary is hidden — the `Coder …`-prefixed
 * phases (working / reasoning / loop / resuming / checkpoint / parse error)
 * plus the two non-prefixed mechanics (`Context reset`, `Checkpoint
 * skipped`) read as thinking dead air, and any future `Coder …` string is
 * caught by the prefix so it can never leak verbatim. Deliberate
 * user-facing signals that aren't internal noise — `Health check` (sandbox
 * probes), `Drift detected` / `Needs more detail` / `Policy intervention` —
 * pass through with their label + detail, since they're the only immediate
 * indication of what the kernel is doing (review #896).
 */
export function translateCoderStatus(rawPhase: string, detail?: string): InlineStatusRender {
  switch (rawPhase) {
    case 'Coder executing...':
      return { phase: executingPhase(detail), detail, thinking: false };
    case 'Running acceptance checks...':
    case 'Checking...':
      return { phase: VERIFYING, detail, thinking: false };
    case 'Coder stopped':
      // Terminal — the lane completes the message immediately after. Keep it
      // neutral rather than surfacing the internal halt reason.
      return { phase: 'Wrapping up…', thinking: false };
    case 'Context reset':
    case 'Checkpoint skipped':
      // Internal mechanics (not `Coder …`-prefixed) — dead air, not a signal.
      return { phase: 'Thinking…', thinking: true };
    default:
      // Internal `Coder …` vocabulary (incl. any future one) → thinking.
      if (/^Coder\b/.test(rawPhase)) return { phase: 'Thinking…', thinking: true };
      // A deliberate user-facing signal — preserve it (label + detail).
      return { phase: rawPhase, detail, thinking: false };
  }
}
