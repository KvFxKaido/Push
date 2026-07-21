/**
 * Composer undo/redo (#1563 item 3).
 *
 * Silvery's TextArea has no undo, but the composer's value is fully
 * controlled by the surface, which sees every mutation: user keystrokes
 * (onChange), history recall, Tab completion, and /editor drafts. This
 * kernel keeps a snapshot history of those values with readline-style
 * coalescing, so undo restores coherent steps instead of per-keystroke
 * churn.
 *
 * Coalescing model — the kernel only sees values, not operations, so runs
 * are classified by length delta against the last known value:
 *  - ±1 char continues an insert/delete run; a run is ONE undo step,
 *    capped at 20 edits (bash groups self-inserts the same way).
 *  - Any other delta (kill, yank, paste, IME commit) is its own step.
 *  - Recall / completion / /editor drafts arrive via `recordDiscrete` and
 *    are their own steps — undoing a recall restores the draft it replaced.
 * Undo/redo application must NOT be re-recorded; the surface applies those
 * values outside the onChange path.
 */

const MAX_STEPS = 100;
const MAX_RUN_EDITS = 20;

type RunKind = 'insert' | 'delete';

export interface ComposerUndo {
  /** Record the value after a user edit (the TextArea onChange path). */
  record(value: string): void;
  /** Record a programmatic replacement (recall, completion, /editor draft). */
  recordDiscrete(value: string): void;
  /** Returns the previous step's value, or null when there is nothing to undo. */
  undo(current: string): string | null;
  /** Returns the next step's value, or null when there is nothing to redo. */
  redo(current: string): string | null;
  /** Drop all history and re-baseline (submit cleared the composer, session switch). */
  reset(baseline: string): void;
}

export function createComposerUndo(baseline = ''): ComposerUndo {
  let past: string[] = [];
  let future: string[] = [];
  let lastKnown = baseline;
  let runKind: RunKind | null = null;
  let runEdits = 0;

  const commitStep = (value: string) => {
    past.push(value);
    if (past.length > MAX_STEPS) past.shift();
  };

  return {
    record(value) {
      if (value === lastKnown) return;
      const delta = value.length - lastKnown.length;
      const kind: RunKind | null = delta === 1 ? 'insert' : delta === -1 ? 'delete' : null;
      if (kind === null || kind !== runKind || runEdits >= MAX_RUN_EDITS) {
        commitStep(lastKnown);
        runKind = kind;
        runEdits = 0;
      }
      runEdits += 1;
      lastKnown = value;
      future = [];
    },
    recordDiscrete(value) {
      if (value === lastKnown) return;
      commitStep(lastKnown);
      runKind = null;
      runEdits = 0;
      lastKnown = value;
      future = [];
    },
    undo(current) {
      const prev = past.pop();
      if (prev === undefined) return null;
      future.push(current);
      lastKnown = prev;
      runKind = null;
      runEdits = 0;
      return prev;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return null;
      commitStep(current);
      lastKnown = next;
      runKind = null;
      runEdits = 0;
      return next;
    },
    reset(newBaseline) {
      past = [];
      future = [];
      lastKnown = newBaseline;
      runKind = null;
      runEdits = 0;
    },
  };
}
