/**
 * tui-verbs.ts — the "what is Push doing right now" vocabulary, plus the
 * reduced-motion guard.
 *
 * Was `tui-spinner.ts`, and it was mostly spinners: five Braille frame tables,
 * a preference (`push spinner` / `/spinner` / `PUSH_SPINNER` / `config.spinner`),
 * a `spinnerFrame` cycler, and a `motionEnabled` switch. All of it went in the
 * same change that restored the verbs, because none of it had a painter: the
 * Silvery migration deleted the ANSI renderer that drew the frames and never
 * rebuilt one, so the preference saved a value, echoed it back, and changed
 * nothing. (`motionEnabled` was the tell — it defaulted false and no production
 * caller ever set it, so every helper behind `isMotionOn()` was permanently
 * static anyway.) The spinner also no longer has a slot to fill: under Visual
 * Language v2 law 8 the working-state animation is the verb shimmer, and a
 * second cycling glyph would be exactly the "two animations beating at
 * different periods" the law names.
 *
 * What's left is the part that carries information rather than decoration:
 *   - `verbForActivity` — activity → short present participle, the label the
 *     header shimmers.
 *   - `moodVerb` — the quiet state, seeded per session so it can't flicker.
 *   - `isReducedMotion` — the canonical env guard, still consumed by the
 *     Silvery surface and `visual-language.ts`.
 *
 * Pure: same input → same output, no renderer and no engine dependency.
 */

/**
 * True when the user has asked for reduced motion via env. The canonical home
 * for the check — `cli/silvery/visual-language.ts` and the surface both route
 * through this rather than re-reading the env, so there is one answer.
 */
export function isReducedMotion(): boolean {
  for (const key of ['PUSH_REDUCED_MOTION', 'REDUCED_MOTION'] as const) {
    const value = (process.env[key] || '').toLowerCase().trim();
    if (value === '' || value === '0' || value === 'false' || value === 'no') continue;
    return true;
  }
  return false;
}

/**
 * What the agent is actively doing — streaming a reply, running a specific
 * tool, or quietly working. Deliberately NOT the run-state machine: "running"
 * is a fact about the loop, this is a fact about the agent.
 *
 * `thinking` is the quiet state (running, nothing observable yet), not a
 * reasoning-token signal — see `verbForActivity`.
 */
export type StatusActivity =
  | { kind: 'thinking' }
  | { kind: 'streaming' }
  | { kind: 'tool'; toolName: string }
  | null;

// The delegation verbs below derive from the shared display seam
// (`lib/role-display.ts`) rather than being spelled here, so this
// "what is it doing" vocabulary can't drift from the rest of the UI. The seam
// phases are title-case ('Editing', 'Verifying'); the header wants lowercase
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
 * Resolve a short verb for the given activity. Pure: same (activity, seed) →
 * same output, no env or state. Returns `null` only when there is no activity
 * to label — i.e. the turn is not running.
 *
 * `seed` (the session id) exists solely for the quiet state; see below.
 */
export function verbForActivity(activity: StatusActivity, seed?: string | null): string | null {
  if (!activity) return null;
  if (activity.kind === 'thinking') {
    // The quiet state: running, no tokens yet, no call pending. It is tempting
    // to render the literal 'thinking', and that is what this returned when the
    // pre-Silvery TUI drove `activity` off reasoning-token events — there, the
    // word was a fact. Silvery's lane emits no reasoning event, so the same
    // word here would be a guess wearing a fact's clothes: all we actually know
    // is that Push is busy and hasn't said anything yet. A mood verb claims
    // exactly that much, and claims it with some character.
    return moodVerb(seed);
  }
  if (activity.kind === 'streaming') return 'replying';
  if (activity.kind === 'tool') {
    return VERB_BY_TOOL[activity.toolName] ?? 'working';
  }
  return null;
}

/**
 * Mood verbs — the quiet state's vocabulary, picked once per session.
 *
 * Fixed pool, deterministic by seed, so the verb stays stable across renders
 * within a session instead of flickering between frames. That stability is the
 * whole reason this is seeded rather than random: the header repaints ~7×/s
 * while the shimmer sweeps, and a verb that re-rolled per frame would be a
 * strobe, not a personality.
 *
 * Length cap: ≤8 chars so the verb fits the narrow header at small terminal
 * widths. Order matters for stability — appending is safe, reordering changes
 * which session gets which verb.
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
