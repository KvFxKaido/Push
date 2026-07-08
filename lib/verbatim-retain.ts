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

/** Provenance tag for spans retained by LLM compaction (vs. `tool_output`). */
export const COMPACTED_SPAN_KIND = 'compacted_span';

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

export interface RetainCompactedSpanInput {
  /** The rendered raw span the summarizer saw (`renderSpanForSummary` output) —
   *  retaining exactly the summarizer's input means a recall reproduces every
   *  detail the summary could have dropped. */
  spanText: string;
  /** Session scope, same contract as `RetainReducedOutputInput.scope`:
   *  retention is skipped when `repoFullName` is empty/absent. `branch` is
   *  accepted (callers pass their whole runtime scope) but deliberately not
   *  persisted — see the `log.append` scope in `retainCompactedSpan`. */
  scope: { repoFullName?: string; branch?: string; chatId?: string };
  /** Human label for `ls`/debug, e.g. `context compaction (12 messages)`. */
  label?: string;
  /** Defaults to the process verbatim log (IndexedDB web, file-backed CLI). */
  verbatimLog?: VerbatimLog;
}

export interface RetainCompactedSpanResult {
  /** Verbatim ref for the retained span, when retention happened. The caller
   *  embeds it in the handoff block (`buildHandoffBlock({ recallRef })`). */
  ref?: string;
}

/**
 * Retain the raw span an LLM compaction is about to summarize away, so the
 * handoff summary can carry a `memory_expand` ref back to the exact original
 * turns. Same best-effort contract as `retainReducedOutput`: a missing scope or
 * log failure is a logged no-op — retention must never block a compaction that
 * is already committed to running.
 */
export async function retainCompactedSpan(
  input: RetainCompactedSpanInput,
): Promise<RetainCompactedSpanResult> {
  if (!input.scope.repoFullName) {
    logRetain('debug', 'compaction_span_retain_skipped_no_scope', {
      spanChars: input.spanText.length,
    });
    return {};
  }
  if (!input.spanText) {
    logRetain('debug', 'compaction_span_retain_skipped_empty', {});
    return {};
  }

  const log = input.verbatimLog ?? getDefaultVerbatimLog();
  try {
    const entry = await log.append({
      // Compacted spans are chat-durable, not branch-moment artifacts: the chat
      // (and the handoff carrying this recall ref) is repo-scoped and survives
      // switch_branch/create_branch, so branch-stamping the entry would make the
      // ref unresolvable after a switch — `verbatimScopeMatches` rejects a query
      // whose branch differs from the entry's. Scope to repo (+chat), never
      // branch, so the handoff's recall promise still holds across switches.
      scope: {
        repoFullName: input.scope.repoFullName,
        ...(input.scope.chatId ? { chatId: input.scope.chatId } : {}),
      },
      text: input.spanText,
      kind: COMPACTED_SPAN_KIND,
      label: input.label,
    });
    logRetain('debug', 'compaction_span_retained', {
      ref: entry.ref,
      bytes: input.spanText.length,
    });
    return { ref: entry.ref };
  } catch (err) {
    logRetain('warn', 'compaction_span_retain_failed', {
      bytes: input.spanText.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
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
