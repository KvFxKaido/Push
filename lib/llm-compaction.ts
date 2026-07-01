/**
 * LLM-based context compaction — the "handoff summary" half of context
 * management.
 *
 * The synchronous heuristic in `message-context-manager.ts` (summarize tool
 * output → drop oldest pairs → hard-trim) is the always-on backstop: it runs
 * inside the pure, sync `transformContextBeforeLLM` boundary and guarantees a
 * turn never overflows the model window. This module is the higher-quality,
 * *asynchronous* complement that fires at a turn boundary BEFORE the heuristic
 * is needed: it asks the model itself to write a structured handoff summary of
 * the older conversation span, the way Codex's "Memento" compaction does (see
 * `docs/research/codex-compacting.md`).
 *
 * Why a separate module from the heuristic:
 *   - It needs a model call, so it can't live in the pure sync transform.
 *   - It is provider-agnostic: the actual call is made through an injected
 *     `PushStream` (the same seam the Auditor/Reviewer use), so this module
 *     stays runtime-agnostic and unit-testable with a fake stream — no web /
 *     CLI specifics leak in (new-feature checklist #3: one source of truth).
 *
 * Losslessness: this module never deletes anything. It returns *which* span to
 * summarize and the summary text; the caller hides the summarized span from
 * the wire (`visibleToModel: false`) while keeping it in the durable transcript
 * and the verbatim log (LCM Phase 3). Nothing the model said is destroyed —
 * only what it *re-reads each turn* shrinks.
 */

import { iteratePushStreamText } from './stream-utils.ts';
import type { LlmMessage, PushStream } from './provider-contract.ts';
import type { ContextBudget } from './context-budget.ts';

// ---------------------------------------------------------------------------
// Prompt (the feature, not a band-aid — this IS the compaction instruction)
// ---------------------------------------------------------------------------

/**
 * System prompt for the summarizer call. Adapted from Codex's compaction
 * template (`templates/compact/prompt.md`) with the community cumulative-
 * history mitigation (Codex issue #14347) folded in so repeated compactions
 * don't progressively forget earlier decisions. OpenAI Codex attribution for
 * the prompt adaptation is tracked in the root NOTICE; the surrounding
 * implementation is Push-native.
 */
export const COMPACTION_SYSTEM_PROMPT = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION.',
  'Another language model has been working a coding task and is about to run',
  'out of context window. Write a handoff summary that lets it (or a fresh',
  'model) seamlessly resume the work with no loss of direction.',
  '',
  'Include, in this order:',
  '1. Goal — the original ask and the current working objective.',
  '2. Progress & key decisions — what has been done and WHY (decisions, not',
  '   just events). Preserve exact file paths, identifiers, commands, and any',
  '   critical data/values the next step needs.',
  '3. Current state — what is in flight right now (open edits, failing tests,',
  '   unresolved errors, branch/PR state).',
  '4. Next steps — the concrete remaining work, ordered.',
  '',
  'If the conversation already contains an earlier handoff summary, extract its',
  'key historical thread (what was done, decisions and why, outcomes) and carry',
  'it forward as a short "Earlier context" section at the top so coherence is',
  'preserved across multiple compactions.',
  '',
  'Be concise and structured. Output only the summary — no preamble, no',
  'meta-commentary about summarizing.',
].join('\n');

/**
 * Prefix wrapped around the model-produced summary when it is injected back
 * into the working context. Frames compaction as a relay handoff rather than
 * amnesia (Codex's `summary_prefix.md` insight) — the receiving model treats
 * it as prior work to build on, not its own truncated memory. OpenAI Codex
 * attribution for the prompt-prefix adaptation is tracked in the root NOTICE.
 */
export const COMPACTION_HANDOFF_PREFIX = [
  '[CONTEXT HANDOFF]',
  'Earlier turns of this conversation were compacted to fit the context window.',
  'The summary below is a faithful handoff of that work — build on it and do',
  'not redo steps it reports as done. Older raw turns remain available via',
  'memory recall if an exact detail is needed.',
].join('\n');

export const COMPACTION_HANDOFF_FOOTER = '[/CONTEXT HANDOFF]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal message shape the partitioner reads. */
export interface CompactableMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  isToolResult?: boolean;
}

export interface LlmCompactionTrigger {
  /** Estimated tokens at or above which LLM compaction should run. Set below
   *  the heuristic's hard ceiling so the model-written summary is the primary
   *  mechanism and the heuristic only ever catches the overflow. */
  triggerTokens: number;
}

export type LlmCompactionSurface = 'web' | 'cli-lead';

export type LlmCompactionTriggerSource = 'handoffTokens' | 'summarizeTokens';

export interface LlmCompactionPolicy extends LlmCompactionTrigger {
  /** Which context-budget threshold drives this surface. */
  triggerSource: LlmCompactionTriggerSource;
  /** Recent-tail budget kept verbatim after compaction. */
  preserveTailTokens: number;
  /** Minimum eligible middle span before spending a model call. */
  minSummarizeTokens: number;
}

const DEFAULT_PRESERVE_TAIL_RATIO = 0.4;
const DEFAULT_PRESERVE_TAIL_CAP = 24_000;
const DEFAULT_MIN_SUMMARIZE_TOKENS = 4_000;

/**
 * Resolve the async LLM-handoff policy for each surface.
 *
 * Web sends the model its full visible transcript, so it can wait for the
 * patient `handoffTokens` threshold before paying a cache-busting summary call.
 * The CLI lead feeds a bounded preamble, so it must fire at the eager
 * `summarizeTokens` threshold; otherwise older turns can fall outside the
 * preamble before a handoff exists to carry them forward.
 */
export function resolveLlmCompactionPolicy(args: {
  surface: LlmCompactionSurface;
  budget: Pick<ContextBudget, 'summarizeTokens' | 'handoffTokens'>;
}): LlmCompactionPolicy {
  const triggerSource: LlmCompactionTriggerSource =
    args.surface === 'cli-lead' ? 'summarizeTokens' : 'handoffTokens';
  const triggerTokens = args.budget[triggerSource];
  return {
    triggerTokens,
    triggerSource,
    preserveTailTokens: Math.min(
      DEFAULT_PRESERVE_TAIL_CAP,
      Math.floor(triggerTokens * DEFAULT_PRESERVE_TAIL_RATIO),
    ),
    minSummarizeTokens: DEFAULT_MIN_SUMMARIZE_TOKENS,
  };
}

export interface PartitionOptions<M> {
  estimateMessageTokens: (message: M) => number;
  /** Keep at least this many tokens of the most-recent tail verbatim — the
   *  turns the model is actively working and must see in full. */
  preserveTailTokens: number;
  /** Don't bother summarizing unless the eligible middle span is at least this
   *  many tokens; below it the round-trip isn't worth a model call. */
  minSummarizeTokens: number;
}

export interface CompactionPartition<M> {
  /** Pinned head — the first real user turn (the goal). Empty if none found. */
  head: M[];
  /** The middle span to be summarized away. */
  summarize: M[];
  /** The preserved recent tail. */
  tail: M[];
  /** Total estimated tokens in `summarize` (what compaction reclaims). */
  summarizeTokens: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function shouldRunLlmCompaction(
  totalTokens: number,
  trigger: LlmCompactionTrigger,
): boolean {
  return totalTokens >= trigger.triggerTokens;
}

/**
 * Split a message history into [head, summarize, tail]. The head pins the first
 * real user turn (the goal); the tail is the most-recent window kept verbatim
 * (sized by token budget); the middle is everything eligible for summarization.
 *
 * Returns an empty `summarize` (and the original head/tail) when there isn't a
 * worthwhile middle span — the caller treats that as "skip compaction".
 */
export function partitionForLlmCompaction<M extends CompactableMessage>(
  messages: M[],
  opts: PartitionOptions<M>,
): CompactionPartition<M> {
  const firstUserIdx = messages.findIndex((m) => m.role === 'user' && !m.isToolResult);
  const headEnd = firstUserIdx >= 0 ? firstUserIdx + 1 : 0;
  const head = messages.slice(0, headEnd);

  // Walk from the end, accumulating tokens until the preserve-tail budget is
  // met. `tailStart` is the first index that belongs to the preserved tail.
  let tailTokens = 0;
  let tailStart = messages.length;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    tailTokens += opts.estimateMessageTokens(messages[i]);
    tailStart = i;
    if (tailTokens >= opts.preserveTailTokens) break;
  }

  const summarize = messages.slice(headEnd, tailStart);
  const tail = messages.slice(tailStart);
  const summarizeTokens = summarize.reduce((sum, m) => sum + opts.estimateMessageTokens(m), 0);

  if (summarizeTokens < opts.minSummarizeTokens || summarize.length === 0) {
    return { head, summarize: [], tail: messages.slice(headEnd), summarizeTokens: 0 };
  }
  return { head, summarize, tail, summarizeTokens };
}

/**
 * Render a span of messages into a single plain-text blob for the summarizer's
 * user message. Tool results are labelled so the model can tell observations
 * from its own turns. Kept deterministic for snapshot tests.
 */
export function renderSpanForSummary<M extends CompactableMessage>(messages: M[]): string {
  return messages
    .map((m) => {
      const label = m.isToolResult ? 'TOOL_RESULT' : m.role.toUpperCase();
      return `### ${label}\n${m.content}`;
    })
    .join('\n\n');
}

/**
 * Wrap a model-produced summary with the handoff frame for injection into the
 * working context. `priorHandoff` (the previous compaction's handoff text, if
 * any) is not re-embedded — the summarizer was already instructed to fold its
 * historical thread in — so this only frames the latest summary.
 */
export function buildHandoffBlock(summary: string): string {
  return `${COMPACTION_HANDOFF_PREFIX}\n\n${summary.trim()}\n\n${COMPACTION_HANDOFF_FOOTER}`;
}

/** Detect a handoff block by its header, so callers can find a prior one in
 *  the transcript / strip nested handoffs. */
export function isHandoffBlock(content: string): boolean {
  return content.includes(COMPACTION_HANDOFF_PREFIX);
}

// ---------------------------------------------------------------------------
// Model call (provider-agnostic via injected stream)
// ---------------------------------------------------------------------------

export interface SummarizeViaModelOptions {
  provider: import('./provider-contract.ts').AIProviderType;
  model: string;
  /** The injected provider stream — resolved by the shell (web/CLI). */
  stream: PushStream<LlmMessage>;
  /** Rendered span to summarize (from `renderSpanForSummary`). */
  spanText: string;
  /** Prior handoff text to carry forward, appended to the span so the model
   *  can extract its historical thread (Codex #14347 cumulative mitigation). */
  priorHandoff?: string;
  /** Activity timeout for the summarizer call. */
  timeoutMs?: number;
}

export interface SummarizeViaModelResult {
  /** The model's summary text, or null when the call failed / returned empty. */
  summary: string | null;
  error: Error | null;
}

const DEFAULT_SUMMARIZE_TIMEOUT_MS = 60_000;

/**
 * Run the one-shot summarizer model call. Mirrors the Auditor/Reviewer seam:
 * a single `iteratePushStreamText` with `systemPromptOverride` so none of the
 * agent's tool/system prompt is built — just the compaction instruction over
 * the old span. Fails soft: any error returns `{ summary: null, error }` and
 * the caller falls back to the heuristic.
 */
export async function summarizeContextViaModel(
  opts: SummarizeViaModelOptions,
): Promise<SummarizeViaModelResult> {
  const userParts = ['Conversation span to compact:', '', opts.spanText];
  if (opts.priorHandoff && opts.priorHandoff.trim()) {
    userParts.push(
      '',
      'A previous handoff summary (fold its key thread into yours):',
      '',
      opts.priorHandoff.trim(),
    );
  }

  const userMessage: LlmMessage = {
    id: 'compaction-span',
    role: 'user',
    content: userParts.join('\n'),
    timestamp: 0,
  };
  const request = {
    provider: opts.provider,
    model: opts.model,
    systemPromptOverride: COMPACTION_SYSTEM_PROMPT,
    messages: [userMessage],
  };

  const { error, text } = await iteratePushStreamText(
    opts.stream,
    request,
    opts.timeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS,
    'Context compaction summarizer timed out',
  );

  if (error) return { summary: null, error };
  const trimmed = text.trim();
  if (!trimmed) {
    return { summary: null, error: new Error('Context compaction summarizer returned empty text') };
  }
  return { summary: trimmed, error: null };
}
