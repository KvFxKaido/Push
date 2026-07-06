/**
 * tui-spinner.ts — frame-based Braille spinners for "busy" indicators.
 *
 * Classic frame-cycling spinners: pick a Braille glyph based on
 * `tick % frames.length`. The caller decides when to show the spinner
 * (typically only while `runState === 'running'`); this module is pure.
 *
 * Scope:
 *   - One-cell Braille frames only — legible at the header's status-dot
 *     position, no multi-cell animations.
 *   - Five variants plus 'off' (the static-dot fallback): braille, orbit,
 *     breathe, pulse, helix. Enough variety without becoming noise.
 *   - Reduced-motion (PUSH_REDUCED_MOTION / REDUCED_MOTION) forces 'off'
 *     via detectSpinnerName. `isReducedMotion()` lives here as the
 *     canonical home now that the color-overlay animator is gone.
 *
 * Verbs (the label that sits next to the spinner glyph in the header)
 * also live in this module so the spinner remains the canonical home for
 * the "what is it doing right now" vocabulary. The mapping is pure:
 * activity → verb, with no dependency on the renderer or the engine.
 */

/**
 * Returns true when the user has asked for reduced motion via env. Gates
 * the spinner — when on, the spinner stays as a static dot regardless of
 * configured Braille animation. Lives here because the spinner is the
 * sole runtime consumer; the standalone `push spinner` CLI command and
 * the TUI's `/spinner` handler both import this same helper so they
 * share one source of truth.
 */
export function isReducedMotion(): boolean {
  for (const key of ['PUSH_REDUCED_MOTION', 'REDUCED_MOTION'] as const) {
    const value = (process.env[key] || '').toLowerCase().trim();
    if (value === '' || value === '0' || value === 'false' || value === 'no') continue;
    return true;
  }
  return false;
}

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

// The delegation verbs below derive from the shared display seam
// (`lib/role-display.ts`) rather than being spelled here, so the spinner's
// "what is it doing" vocabulary can't drift from the rest of the UI. The seam
// phases are title-case ('Editing', 'Verifying'); the spinner wants lowercase
// present participles, so we downcase. Falls back to 'working' for a role with
// no phase (only the Orchestrator, which is never a delegate target).
import { getRoleDisplay } from '../lib/role-display.ts';
import type { AgentRole } from '../lib/runtime-contract.ts';

function roleVerb(role: AgentRole): string {
  return getRoleDisplay(role).phase?.toLowerCase() ?? 'working';
}

// Map a tool name to a short present-participle verb. Keys are the
// canonical tool names emitted by the engine (see `lib/tool-registry.ts`)
// plus the CLI-local handlers from `cli/tools.ts`. Values stay short
// enough to fit the header at narrow terminal widths (≤10 chars).
//
// Unmapped tools fall back to the literal "working" via verbForActivity;
// keep this in sync with the registry rather than chasing every alias.
export const VERB_BY_TOOL: Readonly<Record<string, string>> = {
  // ── Read / inspect ────────────────────────────────────────────
  read_file: 'reading',
  sandbox_read_file: 'reading',
  read_symbol: 'reading',
  read_symbols: 'reading',
  sandbox_read_symbols: 'reading',
  read_symbols_outline: 'reading',
  list_dir: 'listing',
  list_directory: 'listing',
  sandbox_list_dir: 'listing',
  search_files: 'searching',
  sandbox_search: 'searching',
  sandbox_find_references: 'searching',
  grep: 'searching',
  grep_file: 'searching',
  web_search: 'searching',
  fetch_url: 'fetching',

  // ── Edit / write ──────────────────────────────────────────────
  write_file: 'writing',
  sandbox_write_file: 'writing',
  edit_file: 'editing',
  sandbox_edit_file: 'editing',
  sandbox_edit_range: 'editing',
  sandbox_search_replace: 'editing',
  sandbox_apply_patchset: 'editing',
  undo_edit: 'editing',

  // ── Execute ───────────────────────────────────────────────────
  exec: 'running',
  exec_start: 'running',
  exec_poll: 'running',
  exec_wait: 'running',
  exec_write: 'running',
  exec_stop: 'running',
  exec_list_sessions: 'running',
  sandbox_exec: 'running',
  sandbox_run_tests: 'testing',
  sandbox_check_types: 'checking',
  sandbox_verify_workspace: 'verifying',

  // ── Git / branches ────────────────────────────────────────────
  git_status: 'inspecting',
  git_diff: 'inspecting',
  sandbox_diff: 'inspecting',
  git_commit: 'committing',
  sandbox_commit: 'committing',
  prepare_push: 'pushing',
  sandbox_push: 'pushing',
  promote_to_github: 'pushing',
  git_create_branch: 'branching',
  create_branch: 'branching',
  switch_branch: 'branching',
  sandbox_create_branch: 'branching',
  sandbox_switch_branch: 'branching',
  list_branches: 'inspecting',
  delete_branch: 'branching',

  // ── GitHub ────────────────────────────────────────────────────
  fetch_pr: 'fetching',
  list_prs: 'fetching',
  list_commits: 'fetching',
  list_commit_files: 'fetching',
  fetch_checks: 'fetching',
  find_existing_pr: 'fetching',
  check_pr_mergeable: 'checking',
  create_pr: 'opening',
  merge_pr: 'merging',
  trigger_workflow: 'running',
  get_workflow_runs: 'fetching',
  get_workflow_logs: 'fetching',

  // ── Diagnostics / memory / scratchpad / todos ─────────────────
  lsp_diagnostics: 'inspecting',
  save_memory: 'saving',
  sandbox_save_draft: 'saving',
  sandbox_download: 'fetching',
  set_scratchpad: 'noting',
  append_scratchpad: 'noting',
  read_scratchpad: 'reading',
  todo_write: 'planning',
  todo_read: 'reading',
  todo_clear: 'planning',
  plan_tasks: 'planning',

  // ── Conversation ──────────────────────────────────────────────
  ask_user: 'asking',

  // ── Delegation ────────────────────────────────────────────────
  delegate_coder: roleVerb('coder'),
  delegate_explorer: roleVerb('explorer'),
  delegate_reviewer: roleVerb('reviewer'),
  delegate_auditor: roleVerb('auditor'),
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

/**
 * Mood verbs — picked once per session for the running state when no
 * activity-specific verb is available. Fixed pool, deterministic by
 * seed, so the verb stays stable across renders within a session
 * instead of flickering between frames.
 *
 * Length cap: ≤8 chars so the verb fits the narrow header at small
 * terminal widths. Order matters for stability — appending is safe,
 * reordering changes which session gets which verb.
 */
export const MOOD_VERBS: readonly string[] = [
  'roosting',
  'brewing',
  'musing',
  'mulling',
  'weaving',
  'pacing',
  'noodling',
];

/**
 * Pick a mood verb deterministically from `seed`. Same seed → same verb.
 * Empty/missing seed falls back to the first entry. Softens the running-
 * state label without per-frame churn.
 */
export function moodVerb(seed: string | null | undefined): string {
  const s = String(seed || '');
  if (!s) return MOOD_VERBS[0];
  // Simple FNV-1a-style hash over codepoints. Doesn't need to be
  // crypto-quality — just stable and well-distributed for short strings.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return MOOD_VERBS[h % MOOD_VERBS.length];
}

// ── Motion helpers ────────────────────────────────────────────────
//
// One switch governs all TUI micro-motion: it is on iff a spinner is
// active (`spinner.name !== 'off'`), which already folds in the
// reduced-motion env guard and the user's spinner preference. The TUI
// syncs it via `setMotionEnabled` whenever the spinner changes, so motion
// never runs behind a user's back — spinner off → everything static.
// `isReducedMotion()` stays as a hard backstop for direct callers/tests.
let motionEnabled = false;

/** Sync motion to the resolved spinner state. Called by the TUI. */
export function setMotionEnabled(on: boolean): void {
  motionEnabled = on;
}

/** True when TUI micro-motion should animate. */
export function isMotionOn(): boolean {
  return motionEnabled && !isReducedMotion();
}

/**
 * Fixed-width (3-column) animated ellipsis driven by tick, so text that
 * follows never reflows as the dots cycle. Motion off → static '…'.
 * `speed` = ticks per dot step (higher is slower).
 */
export function animatedEllipsis(tick: number, speed = 4): string {
  if (!isMotionOn()) return '…';
  const n = Math.floor((tick / Math.max(1, speed)) % 4);
  return ['   ', '.  ', '.. ', '...'][n];
}

/**
 * Small cycling glyph for a "LIVE" badge or an in-flight tool row —
 * motion that carries meaning (this thing is still active), not
 * decoration. Motion off → static '●'.
 */
export function liveFrame(tick: number): string {
  if (!isMotionOn()) return '●';
  const frames = ['●', '◉', '○', '◌'];
  return frames[((tick % frames.length) + frames.length) % frames.length];
}
