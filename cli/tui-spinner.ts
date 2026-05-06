/**
 * tui-spinner.ts — frame-based Braille spinners for "busy" indicators.
 *
 * Unlike the color animator (time-varying hue/brightness on static text),
 * these are classic frame-cycling spinners: pick a Braille glyph based on
 * `tick % frames.length`. The caller decides when to show the spinner
 * (typically only while `runState === 'running'`); this module is pure.
 *
 * Scope for the first cut:
 *   - One-cell Braille frames only — legible at the header's status-dot
 *     position, no multi-cell animations.
 *   - Five variants plus 'off' (the static-dot fallback): braille, orbit,
 *     breathe, pulse, helix. Enough variety without becoming noise.
 *   - Reduced-motion (PUSH_REDUCED_MOTION / REDUCED_MOTION) forces 'off'
 *     via detectSpinnerName, mirroring the animator's guard.
 *
 * Verbs (the label that sits next to the spinner glyph in the header)
 * also live in this module so the spinner remains the canonical home for
 * the "what is it doing right now" vocabulary. The mapping is pure:
 * activity → verb, with no dependency on the renderer or the engine.
 */

import { isReducedMotion } from './tui-animator.js';

export type SpinnerName = 'off' | 'braille' | 'orbit' | 'breathe' | 'pulse' | 'helix';

export const SPINNER_NAMES: readonly SpinnerName[] = [
  'off',
  'braille',
  'orbit',
  'breathe',
  'pulse',
  'helix',
];

export interface SpinnerVariant {
  label: string;
  description: string;
  frames: readonly string[];
}

export const SPINNERS: Record<SpinnerName, SpinnerVariant> = {
  off: {
    label: 'Off',
    description: 'Static dot (no animation)',
    frames: [],
  },
  braille: {
    label: 'Braille',
    description: 'Classic 10-frame Braille dot loop',
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },
  orbit: {
    label: 'Orbit',
    description: 'A single dot orbiting the cell',
    frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  },
  breathe: {
    label: 'Breathe',
    description: 'Fills and empties smoothly',
    frames: ['⠀', '⠄', '⠆', '⠇', '⡇', '⣇', '⣧', '⣷', '⣿', '⣷', '⣧', '⣇', '⡇', '⠇', '⠆', '⠄'],
  },
  pulse: {
    label: 'Pulse',
    description: 'Grows and shrinks from the centre',
    frames: ['⠂', '⠆', '⠶', '⠾', '⡿', '⣿', '⡿', '⠾', '⠶', '⠆'],
  },
  helix: {
    label: 'Helix',
    description: 'Diagonal helix twist',
    frames: [
      '⠁',
      '⠉',
      '⠙',
      '⠚',
      '⠒',
      '⠂',
      '⠂',
      '⠒',
      '⠲',
      '⠴',
      '⠤',
      '⠄',
      '⠄',
      '⠤',
      '⠴',
      '⠲',
      '⠒',
      '⠂',
      '⠂',
      '⠒',
      '⠚',
      '⠙',
      '⠉',
      '⠁',
    ],
  },
};

export function isSpinnerName(value: unknown): value is SpinnerName {
  // `Object.hasOwn`, not `in`, to reject prototype keys like `constructor`
  // that would slip past validation and crash downstream (same bug class
  // we already fixed for theme names).
  return typeof value === 'string' && Object.hasOwn(SPINNERS, value);
}

/**
 * Resolve the spinner name from the environment. Reduced-motion always
 * wins and forces 'off'. Otherwise returns the named spinner from
 * `PUSH_SPINNER`, or `null` when the env doesn't express a preference
 * so callers can fall back to the default (typically 'off').
 */
export function detectSpinnerName(): SpinnerName | null {
  if (isReducedMotion()) return 'off';
  const env = (process.env.PUSH_SPINNER || '').toLowerCase().trim();
  if (!env) return null;
  return isSpinnerName(env) ? env : null;
}

/**
 * The glyph for this spinner at the given tick, or `null` when the
 * spinner is 'off' (so callers fall back to whatever static glyph they
 * would have drawn). Pure function — same (name, tick) always yields
 * the same glyph, and unit-testable without any terminal state.
 */
export function spinnerFrame(name: SpinnerName, tick: number): string | null {
  const variant = SPINNERS[name];
  if (!variant || variant.frames.length === 0) return null;
  const n = variant.frames.length;
  const idx = ((tick % n) + n) % n;
  return variant.frames[idx];
}

// ── Verbs ────────────────────────────────────────────────────────
//
// The spinner sits next to a short status verb in the header. The verb
// reflects what the agent is actively doing — reasoning, streaming a
// reply, or running a specific tool — not the run-state machine itself.

export type SpinnerActivity =
  | { kind: 'thinking' }
  | { kind: 'streaming' }
  | { kind: 'tool'; toolName: string }
  | null;

// Map a tool name to a short present-participle verb. Keys are the
// canonical tool names emitted by the engine; values stay short enough
// to fit the header at narrow terminal widths (~8 chars max).
export const VERB_BY_TOOL: Readonly<Record<string, string>> = {
  read_file: 'reading',
  read_symbol: 'reading',
  read_symbols: 'reading',
  list_dir: 'listing',
  search_files: 'searching',
  grep: 'searching',
  web_search: 'searching',
  write_file: 'writing',
  edit_file: 'editing',
  undo_edit: 'editing',
  exec: 'running',
  exec_start: 'running',
  exec_poll: 'running',
  exec_write: 'running',
  exec_stop: 'running',
  exec_list_sessions: 'running',
  sandbox_exec: 'running',
  git_status: 'inspecting',
  git_diff: 'inspecting',
  git_commit: 'committing',
  git_create_branch: 'branching',
  create_branch: 'branching',
  switch_branch: 'branching',
  sandbox_create_branch: 'branching',
  sandbox_switch_branch: 'branching',
  lsp_diagnostics: 'inspecting',
  read_symbols_outline: 'reading',
  save_memory: 'saving',
  ask_user: 'asking',
  delegate_coder: 'coding',
  delegate_explorer: 'exploring',
  delegate_reviewer: 'reviewing',
  delegate_auditor: 'auditing',
};

/**
 * Resolve a short verb for the given activity. Pure: same input → same
 * output, no env or state. Returns `null` when there's no activity to
 * label (caller falls back to the run-state label).
 */
export function verbForActivity(activity: SpinnerActivity): string | null {
  if (!activity) return null;
  if (activity.kind === 'thinking') return 'thinking';
  if (activity.kind === 'streaming') return 'replying';
  if (activity.kind === 'tool') {
    return VERB_BY_TOOL[activity.toolName] ?? 'working';
  }
  return null;
}
