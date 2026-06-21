/**
 * Retain the full, unreduced output of a reduced tool result in the verbatim
 * log so the model can pull it back later (LCM Phase 3, the "keep the raw
 * stdout/stderr" half that `tool-output-reducers.ts` promised but had nowhere
 * durable to put).
 *
 * When `reduceToolOutput` actually trims an exec result, the model only sees the
 * reduced text plus an omission marker. This appends the *raw* output to the
 * verbatim log, scoped to the session, and returns a marker pointing at the ref
 * so the model can `memory_expand` it to the exact original.
 *
 * Best-effort by contract: a missing scope or a log failure is a no-op (returns
 * `{}`), never an error — retention must never break the exec path. The CLI
 * resolves the session scope via the workspace identity; the web threads it from
 * the tool-execution context. Both call this one helper so the behavior, marker
 * text, and `kind`/`label` tagging are defined once.
 */

import type { ReducedOutput } from './tool-output-reducers.js';
import { getDefaultVerbatimLog, type VerbatimLog } from './verbatim-log.js';

export interface RetainReducedOutputInput {
  reduced: ReducedOutput;
  /** The full, unreduced text to retain (exactly what the model would have seen
   *  without reduction — typically the formatted stdout/stderr block). */
  rawText: string;
  /** Session scope. `repoFullName` is optional at the call site (web threads it
   *  from context, CLI from workspace identity); retention is skipped when it is
   *  empty/absent, since there is then no scope to guard a recall to. */
  scope: { repoFullName?: string; branch?: string; chatId?: string };
  /** The command, used as the entry label for `ls`/debug. */
  command?: string;
  /** Defaults to the process verbatim log (in-memory web, file-backed CLI). */
  verbatimLog?: VerbatimLog;
}

export interface RetainReducedOutputResult {
  /** Verbatim ref for the retained raw output, when retention happened. */
  ref?: string;
  /** A one-line marker to append to the model-facing text, when retention
   *  happened — tells the model how to recall the full output. */
  marker?: string;
}

function logRetain(level: 'debug' | 'warn', event: string, ctx: Record<string, unknown>): void {
  // stderr, matching the memory layer (CLI stdout is the user/--json channel).
  console.error(JSON.stringify({ level, event, ...ctx }));
}

export async function retainReducedOutput(
  input: RetainReducedOutputInput,
): Promise<RetainReducedOutputResult> {
  // Only retain when the reducer actually dropped something — an unreduced
  // result already shows the model everything, so there's nothing to recall.
  if (!input.reduced.reduced) return {};
  // No scope ⇒ no scope-guarded recall is possible; skip rather than store an
  // unreachable entry. (Web paths without a resolved repo, or unidentified CLI
  // workspaces, land here.)
  if (!input.scope.repoFullName) {
    logRetain('debug', 'verbatim_retain_skipped_no_scope', { command: input.command ?? null });
    return {};
  }
  const text = input.rawText;
  if (!text) return {};

  const log = input.verbatimLog ?? getDefaultVerbatimLog();
  try {
    const entry = await log.append({
      scope: {
        repoFullName: input.scope.repoFullName,
        branch: input.scope.branch,
        chatId: input.scope.chatId,
      },
      text,
      kind: 'tool_output',
      label: input.command,
    });
    logRetain('debug', 'verbatim_retain_stored', {
      ref: entry.ref,
      bytes: text.length,
      reducedTo: input.reduced.reducedChars,
    });
    return {
      ref: entry.ref,
      marker:
        `\n[Output reduced ${input.reduced.originalChars}→${input.reduced.reducedChars} chars. ` +
        `Recall the full output with memory_expand refs=["${entry.ref}"].]`,
    };
  } catch (err) {
    logRetain('warn', 'verbatim_retain_failed', {
      bytes: text.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
