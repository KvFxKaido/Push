/**
 * Post-edit diagnostics — appends file-scoped type-checker findings to
 * successful `write_file` / `edit_file` results, so the model sees breakage
 * it just introduced in the same round instead of having to decide to call
 * `lsp_diagnostics` (the model that just wrote a bug is the least likely to
 * check for it). Pattern borrowed from charmbracelet/crush, where the
 * edit/write tools inject LSP diagnostics into their own results — see
 * `docs/research/charmbracelet crush — Lessons for Push.md`, takeaway 1.
 *
 * Owner module per the cross-surface checklist: the per-workspace state
 * (adaptive disable, once-only notes) and the budget policy live here, not
 * in the `cli/tools.ts` switch. CLI-only by design — the web surface has no
 * diagnostics runner (see `docs/archive/cli/runbooks/LSP Diagnostics Plan.md`).
 *
 * Cost model: Push's checkers are compiler subprocesses (`tsc --noEmit`,
 * pyright/ruff, `cargo check`, `go vet`), not an incremental LSP, so every
 * run is a full project check filtered to the edited file. Guards, in order:
 *
 *   1. Config/env opt-out — `PUSH_POST_EDIT_DIAGNOSTICS=0` (default on).
 *   2. Extension gate — only files a checker family actually covers.
 *   3. Adaptive disable — a run that exceeds the time budget
 *      (`PUSH_POST_EDIT_DIAGNOSTICS_BUDGET_MS`, default 10s) disables the
 *      loop for that workspace for the rest of the process and tells the
 *      model once; unsupported project types and missing checkers disable
 *      silently. Transient checker failures do NOT disable.
 *
 * Known limitation: each mutation in a per-turn batch triggers its own run
 * (the executor has no batch-position signal), so intermediate results in a
 * multi-file batch are checked redundantly. The budget bounds that cost to
 * fast checkers, where the redundant runs are cheap; batch-aware deferral is
 * the follow-up if it shows up in practice.
 */

import path from 'node:path';

import {
  runDiagnostics as defaultRunDiagnostics,
  type Diagnostic,
  type DiagnosticRunOptions,
  type FullDiagnosticResult,
} from './diagnostics.ts';

export const POST_EDIT_DIAGNOSTICS_ENV_VAR = 'PUSH_POST_EDIT_DIAGNOSTICS';
export const POST_EDIT_DIAGNOSTICS_BUDGET_ENV_VAR = 'PUSH_POST_EDIT_DIAGNOSTICS_BUDGET_MS';
export const DEFAULT_POST_EDIT_DIAGNOSTICS_BUDGET_MS = 10_000;

/** Cap on findings lines appended to a tool result. */
const MAX_REPORTED_DIAGNOSTICS = 20;

/**
 * Extensions the checker families cover. Anything else (docs, configs,
 * assets) skips before touching the filesystem. Aligned with
 * `detectProjectType` in `cli/diagnostics.ts`.
 */
const CHECKABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.rs',
  '.go',
]);

/**
 * Which extensions each detected project type's checker can actually say
 * something about. Used post-run: a `.py` edit in a workspace whose marker
 * resolved to `typescript` would otherwise produce a vacuously "clean"
 * note (tsc ran, the filter matched nothing).
 */
const PROJECT_TYPE_EXTENSIONS: Record<string, Set<string>> = {
  typescript: new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']),
  node: new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']),
  python: new Set(['.py', '.pyi']),
  rust: new Set(['.rs']),
  go: new Set(['.go']),
};

export type DiagnosticsRunner = (
  workspaceRoot: string,
  specificPath: string | null,
  opts?: DiagnosticRunOptions,
) => Promise<FullDiagnosticResult>;

export interface PostEditDiagnosticsOptions {
  /** Per-call override; wins over the env var. Tests and embedders. */
  explicitEnabled?: boolean;
  /** Time budget override; wins over the env var. */
  budgetMs?: number;
  /** Env source (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Injectable checker for tests. */
  runner?: DiagnosticsRunner;
}

export interface PostEditDiagnosticsOutcome {
  /**
   * Text to append verbatim to the tool result (starts with its own
   * separator), or null when there is nothing the model needs to see.
   */
  note: string | null;
  /** Structured counts/state for `meta.diagnostics`, or null on skip. */
  meta: Record<string, unknown> | null;
}

interface WorkspaceState {
  disabled: boolean;
  disabledReason: string | null;
  /** Skip/disable reasons already logged for this workspace (once each). */
  loggedReasons: Set<string>;
}

const workspaceStates = new Map<string, WorkspaceState>();

function getWorkspaceState(workspaceRoot: string): WorkspaceState {
  let state = workspaceStates.get(workspaceRoot);
  if (!state) {
    state = { disabled: false, disabledReason: null, loggedReasons: new Set() };
    workspaceStates.set(workspaceRoot, state);
  }
  return state;
}

/** Test seam — clears adaptive-disable state between test cases. */
export function resetPostEditDiagnosticsState(): void {
  workspaceStates.clear();
}

/**
 * Structured log, once per (workspace, event+reason). This module runs on
 * the CLI, so logs go to stderr — stdout is reserved for user output and
 * `--json` payloads (see CLAUDE.md "Symmetric structured logs").
 */
function logOnce(
  state: WorkspaceState,
  level: 'info' | 'warn',
  event: string,
  ctx: Record<string, unknown>,
): void {
  const key = `${event}:${String(ctx.reason ?? '')}`;
  if (state.loggedReasons.has(key)) return;
  state.loggedReasons.add(key);
  console.error(JSON.stringify({ level, event, ...ctx }));
}

export function resolvePostEditDiagnosticsEnabled(input: {
  explicit?: boolean;
  env?: string;
}): boolean {
  if (typeof input.explicit === 'boolean') return input.explicit;
  const env = (input.env ?? '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') return false;
  if (env === '1' || env === 'true' || env === 'on') return true;
  return true; // default on
}

function resolveBudgetMs(explicit: number | undefined, env: string | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  const parsed = Number.parseInt((env ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_POST_EDIT_DIAGNOSTICS_BUDGET_MS;
}

function formatFindings(
  diagnostics: Diagnostic[],
  projectType: string | null,
  relPath: string,
): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const ordered = [...errors, ...warnings];
  const shown = ordered.slice(0, MAX_REPORTED_DIAGNOSTICS);
  const lines = shown.map(
    (d) =>
      `${d.file}:${d.line}:${d.col} [${d.severity}] ${d.code ? `(${d.code}) ` : ''}${d.message}`,
  );
  const more =
    ordered.length > shown.length
      ? `\n(+${ordered.length - shown.length} more — run lsp_diagnostics for the full list)`
      : '';
  return `\n\nDiagnostics (${projectType} — ${relPath}): ${errors.length} error(s), ${warnings.length} warning(s)\n${lines.join('\n')}${more}`;
}

/**
 * Run the post-edit diagnostics loop for a just-mutated file. Never throws;
 * a failure here must not fail the mutation that already succeeded.
 */
export async function runPostEditDiagnostics(
  workspaceRoot: string,
  filePath: string,
  options: PostEditDiagnosticsOptions = {},
): Promise<PostEditDiagnosticsOutcome> {
  const env = options.env ?? process.env;
  const state = getWorkspaceState(workspaceRoot);
  const skip: PostEditDiagnosticsOutcome = { note: null, meta: null };

  const enabled = resolvePostEditDiagnosticsEnabled({
    explicit: options.explicitEnabled,
    env: env[POST_EDIT_DIAGNOSTICS_ENV_VAR],
  });
  if (!enabled) {
    logOnce(state, 'info', 'post_edit_diagnostics_skipped', {
      reason: 'config_disabled',
      workspaceRoot,
    });
    return skip;
  }

  if (!CHECKABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return skip; // Common and expected — not worth a log line per README edit.
  }

  if (state.disabled) {
    logOnce(state, 'info', 'post_edit_diagnostics_skipped', {
      reason: 'workspace_disabled',
      disabledReason: state.disabledReason,
      workspaceRoot,
    });
    return skip;
  }

  const budgetMs = resolveBudgetMs(options.budgetMs, env[POST_EDIT_DIAGNOSTICS_BUDGET_ENV_VAR]);
  const runner = options.runner ?? defaultRunDiagnostics;
  const startedAt = Date.now();
  let result: FullDiagnosticResult;
  try {
    result = await runner(workspaceRoot, filePath, { timeoutMs: budgetMs });
  } catch (err) {
    // Defensive: runDiagnostics returns structured errors rather than
    // throwing, but an injected runner (or a future refactor) might not.
    logOnce(state, 'warn', 'post_edit_diagnostics_failed', {
      reason: 'runner_threw',
      message: err instanceof Error ? err.message : String(err),
      workspaceRoot,
    });
    return skip;
  }
  const durationMs = Date.now() - startedAt;

  if (result.error) {
    switch (result.error.code) {
      case 'DIAGNOSTIC_TIMEOUT': {
        // Too slow for a per-edit loop in this workspace — disable for the
        // rest of the process and tell the model once so it knows to fall
        // back to explicit lsp_diagnostics calls.
        state.disabled = true;
        state.disabledReason = 'budget_exceeded';
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'post_edit_diagnostics_disabled',
            reason: 'budget_exceeded',
            budgetMs,
            durationMs,
            workspaceRoot,
          }),
        );
        return {
          note: `\n\n[Post-edit diagnostics] The project check exceeded its ${budgetMs}ms budget, so automatic post-edit diagnostics are disabled for this workspace for the rest of this process. Run lsp_diagnostics manually after significant changes.`,
          meta: { ran: false, reason: 'budget_exceeded', budgetMs, durationMs },
        };
      }
      case 'UNSUPPORTED_PROJECT_TYPE':
      case 'DIAGNOSTIC_TOOL_NOT_FOUND': {
        // Nothing to run here, ever — disable silently (no note: nagging
        // the model about a missing checker on every edit helps nobody).
        state.disabled = true;
        state.disabledReason = result.error.code;
        logOnce(state, 'info', 'post_edit_diagnostics_disabled', {
          reason: result.error.code,
          workspaceRoot,
        });
        return skip;
      }
      default: {
        // Transient checker failure — keep trying on later edits.
        logOnce(state, 'warn', 'post_edit_diagnostics_failed', {
          reason: result.error.code,
          message: result.error.message,
          workspaceRoot,
        });
        return skip;
      }
    }
  }

  const covered = PROJECT_TYPE_EXTENSIONS[result.projectType ?? ''];
  if (!covered || !covered.has(path.extname(filePath).toLowerCase())) {
    logOnce(state, 'info', 'post_edit_diagnostics_skipped', {
      reason: 'checker_mismatch',
      projectType: result.projectType,
      workspaceRoot,
    });
    return skip;
  }

  const relPath = path.relative(workspaceRoot, filePath) || path.basename(filePath);
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.length - errors;
  console.error(
    JSON.stringify({
      level: 'info',
      event: 'post_edit_diagnostics_ran',
      projectType: result.projectType,
      errors,
      warnings,
      durationMs,
      workspaceRoot,
    }),
  );

  const meta = { ran: true, projectType: result.projectType, errors, warnings, durationMs };
  if (result.diagnostics.length === 0) {
    // Positive confirmation is deliberate: silence would be ambiguous
    // (didn't run vs. clean), and it teaches the model the loop exists so
    // it doesn't redundantly call lsp_diagnostics after every edit.
    return { note: `\n\nDiagnostics: clean (${result.projectType} — ${relPath}).`, meta };
  }
  return { note: formatFindings(result.diagnostics, result.projectType, relPath), meta };
}
