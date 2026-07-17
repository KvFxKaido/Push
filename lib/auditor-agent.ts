/**
 * Auditor Agent — reviews diffs for safety before allowing commits,
 * and evaluates Coder output for completeness against acceptance criteria.
 *
 * Two modes:
 * - **Commit mode** (runAuditor): binary SAFE/UNSAFE security review on diffs.
 * - **Evaluation mode** (runAuditorEvaluation): COMPLETE/INCOMPLETE verdict
 *   against the original task + acceptance criteria after Coder delegation.
 *
 * Uses either an explicit provider/model override (for chat-locked conversations)
 * or the active provider with the role-specific model resolved via providers.ts.
 * This keeps the Auditor aligned with the current chat selection when available,
 * while preserving the global-backend fallback for non-chat flows.
 *
 * Design: fail-safe. If the Auditor returns invalid JSON or errors,
 * the verdict defaults to UNSAFE / INCOMPLETE.
 */

import type { AIProviderType, LlmMessage, PushStream } from './provider-contract.js';
import type { MemoryScope, RunEventInput } from './runtime-contract.js';
import type { AuditorPromptContext } from './role-context.js';
import { formatCoderState, type CoderWorkingMemory } from './working-memory.js';
import { SIZE_BUDGETS } from './size-budgets.js';
import { iteratePushStreamText } from './stream-utils.js';
import { parseDiffStats, chunkDiffByFile, classifyFilePath } from './diff-utils.js';
import { detectAiCommentPatterns, formatCommentCheckBlock } from './comment-check.js';
import type { AuditorFileContext } from './auditor-file-context.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import { formatVerificationPolicyBlock, type VerificationPolicy } from './verification-policy.js';
import { z } from 'zod';
import {
  parseStructured,
  zodToStrictJsonSchema,
  applyStructuredOutput,
} from './structured-output.js';
import type { ResponseFormatSpec } from './provider-contract.js';

const AUDITOR_TIMEOUT_MS = 90_000; // 90s — allows for richer file-context processing

// ---------------------------------------------------------------------------
// Response schemas — the single source of truth for the JSON shapes the
// Auditor prompts ask the model to emit. Per-field `.catch` defaults encode
// the same fallbacks the parse sites used to apply with inline `typeof`
// guards, so validation is behaviour-preserving: a malformed-but-parseable
// field falls back to its default rather than failing the whole parse.
// ---------------------------------------------------------------------------

/** One entry of the Auditor verdict's `risks` array. */
const AuditRiskSchema = z
  .object({
    level: z.enum(['low', 'medium', 'high']).catch('medium'),
    description: z.string().catch('Unknown risk'),
  })
  // A non-object element (the prompt occasionally yields a bare string)
  // collapses to a generic medium risk, matching the old `asRecord(risk)`
  // null-coalescing behaviour.
  .catch({ level: 'medium', description: 'Unknown risk' });

/** Commit-mode SAFE/UNSAFE verdict payload. */
const AuditorVerdictSchema = z.object({
  verdict: z.enum(['safe', 'unsafe']).catch('unsafe'),
  summary: z.string().catch('No summary provided'),
  risks: z.array(AuditRiskSchema).catch([]),
});

/**
 * Native structured-output constraint for the commit-mode verdict, derived from
 * the same zod schema `parseStructured` validates against — one source of truth.
 * Attached to the request only when the caller signals the model supports
 * structured outputs (`supportsStructuredOutput`); `parseStructured` still runs
 * as the validation backstop regardless.
 */
const AUDITOR_VERDICT_RESPONSE_FORMAT: ResponseFormatSpec = {
  name: 'auditor_verdict',
  schema: zodToStrictJsonSchema(AuditorVerdictSchema),
  strict: true,
};

/** Evaluation-mode COMPLETE/INCOMPLETE completeness payload. */
const AuditorEvaluationSchema = z.object({
  verdict: z.enum(['complete', 'incomplete']).catch('incomplete'),
  summary: z.string().catch('No summary provided'),
  // Drop any non-string gaps rather than failing — mirrors the old
  // `Array.isArray(...) ? filter(string) : []` coercion.
  gaps: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string') : []),
    z.array(z.string()),
  ),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
});

/** Native structured-output constraint for the evaluation verdict. See
 *  `AUDITOR_VERDICT_RESPONSE_FORMAT` — same derive-from-zod, one-source rule. */
const AUDITOR_EVALUATION_RESPONSE_FORMAT: ResponseFormatSpec = {
  name: 'auditor_evaluation',
  schema: zodToStrictJsonSchema(AuditorEvaluationSchema),
  strict: true,
};

export interface HookResult {
  exitCode: number;
  output: string;
}

export interface AuditVerdictCardData {
  verdict: 'safe' | 'unsafe';
  summary: string;
  risks: { level: 'low' | 'medium' | 'high'; description: string }[];
  filesReviewed: number;
}

export interface AuditorRunOptions {
  provider: AIProviderType;
  /**
   * PushStream the Auditor iterates directly. Phase 6 of the PushStream
   * gateway migration moved the Auditor off the 12-arg `ProviderStreamFn`
   * callback — callers are now responsible for assembling a PushStream for
   * the target provider (either a native one like `openrouterStream`, or a
   * legacy `ProviderStreamFn` wrapped with `providerStreamFnToPushStream`).
   *
   * When omitted (or when `provider === 'demo'`), the Auditor fails safely
   * with an UNSAFE verdict.
   */
  stream?: PushStream<LlmMessage>;
  modelId?: string;
  context?: AuditorPromptContext;
  hookResult?: HookResult | null;
  fileContexts?: AuditorFileContext[];
  /**
   * The target model honors native structured outputs (OpenAI `response_format`
   * json_schema). When true, the kernel attaches the verdict's JSON-Schema
   * constraint so the upstream constrains generation server-side. Computed by
   * the surface (which owns the model catalog); the kernel stays catalog-
   * agnostic. Defaults off → unchanged behavior. See `docs/runbooks/OpenRouter
   * Capability Expansion.md`.
   */
  supportsStructuredOutput?: boolean;
  resolveRuntimeContext: ResolveAuditorRuntimeContextFn;
  /**
   * Optional run-event sink. When set, the kernel emits an
   * `assistant.prompt_snapshot` event once after the auditor's system
   * prompt is built so a debug surface can answer "what went to the
   * Auditor for this gate?" without re-running the build. Tagged with
   * `round: 0` (single-shot — Auditor doesn't loop).
   */
  onRunEvent?: (event: RunEventInput) => void;
}

export type ResolveAuditorRuntimeContextFn = (
  diff: string,
  context?: AuditorPromptContext,
) => Promise<string>;

export type ResolveAuditorEvaluationMemoryBlockFn = (
  task: string,
  diff: string | null,
  scope?: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId' | 'taskGraphId' | 'taskId'> | null,
) => Promise<string | null>;

export interface AuditorEvaluationOptions {
  provider: AIProviderType;
  /** See `AuditorRunOptions.stream`. */
  stream?: PushStream<LlmMessage>;
  modelId?: string;
  coderRounds?: number;
  coderMaxRounds?: number;
  criteriaResults?: { id: string; passed: boolean; output: string }[];
  verificationPolicy?: VerificationPolicy;
  memoryScope?: Pick<
    MemoryScope,
    'repoFullName' | 'branch' | 'chatId' | 'taskGraphId' | 'taskId'
  > | null;
  resolveEvaluationMemoryBlock?: ResolveAuditorEvaluationMemoryBlockFn;
  /**
   * Evaluating the inline lead's own turn rather than a delegated Coder's
   * output. Swaps the Evaluator's subject vocabulary ("the Coder" → "the
   * assistant") so the user-facing verdict doesn't call the conversational
   * lead "the Coder". Defaults off (delegated framing).
   */
  leadMode?: boolean;
  /** Compact execution-ledger context produced by the runtime, not model prose. */
  toolLedgerContext?: string;
  /** See `AuditorRunOptions.supportsStructuredOutput`. */
  supportsStructuredOutput?: boolean;
}

// ---------------------------------------------------------------------------
// Coalesced promise — dedup concurrent audits on the same diff+provider+context
// ---------------------------------------------------------------------------
export type AuditResult = { verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData };
const pendingAudits = new Map<string, Promise<AuditResult>>();
const auditListeners = new Map<string, Set<(phase: string) => void>>();
const auditLatestPhase = new Map<string, string>();

const streamIds = new WeakMap<PushStream<LlmMessage>, number>();
let nextStreamId = 0;

function getStreamId(stream: PushStream<LlmMessage> | undefined): number | null {
  if (!stream) return null;
  let id = streamIds.get(stream);
  if (id === undefined) {
    id = nextStreamId++;
    streamIds.set(stream, id);
  }
  return id;
}

function fingerprintString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function auditCoalesceKey(
  stream: PushStream<LlmMessage> | undefined,
  diff: string,
  provider: string,
  modelId: string | undefined,
  runtimeContext: string,
  hookResult?: HookResult | null,
  fileContexts?: AuditorFileContext[],
): string {
  return JSON.stringify({
    streamId: getStreamId(stream),
    provider,
    modelId: modelId ?? '',
    runtimeContext,
    hookResult: hookResult
      ? {
          exitCode: hookResult.exitCode,
          output: hookResult.output,
        }
      : null,
    // Compact fingerprint — discriminates by path, size, and truncation without
    // serializing up to 60KB of file content into the Map key.
    fileContextFingerprint: (fileContexts ?? []).map(
      (ctx) => `${ctx.path}:${ctx.content.length}:${ctx.truncated ? 1 : 0}`,
    ),
    diffFingerprint: fingerprintString(diff),
  });
}

function addAuditListener(key: string, onStatus: (phase: string) => void): void {
  const listeners = auditListeners.get(key);
  if (!listeners) return;
  listeners.add(onStatus);
  const latestPhase = auditLatestPhase.get(key);
  if (latestPhase) onStatus(latestPhase);
}

function broadcastAuditStatus(key: string, phase: string): void {
  auditLatestPhase.set(key, phase);
  auditListeners.get(key)?.forEach((listener) => listener(phase));
}

const AUDITOR_SYSTEM_PROMPT = `You are the Auditor agent for Push, a mobile AI coding assistant. Your sole job is to review code diffs for safety.

You MUST respond with ONLY a valid JSON object. No other text.

Schema:
{
  "verdict": "safe" | "unsafe",
  "summary": "One sentence explaining the verdict",
  "risks": [
    { "level": "low" | "medium" | "high", "description": "What the risk is" }
  ]
}

Review criteria:
- Hardcoded secrets, tokens, passwords, API keys → UNSAFE (high)
- Network calls to novel external endpoints → UNSAFE (high). To assess novelty: if the domain appears in unchanged context lines within the diff, it is a known domain (lower novelty) — but still assess the specific endpoint path, auth, and payload independently. A known domain does not make a new endpoint safe. If the domain appears only in added lines with no prior context, treat it as fully novel (higher risk).
- Disabled security features (CORS, auth checks) → UNSAFE (high)
- SQL injection, XSS, command injection vectors → UNSAFE (high)
- Overly broad file permissions → UNSAFE (medium)
- Missing input validation on user-facing code → UNSAFE (medium)
- Dead code or debug artifacts (console.log) → SAFE but note as low risk
- AI-generated comment noise (operation narration like "// added validation", meta markers, trivial docblocks) → SAFE but note each as low risk. See [COMMENT CHECK].
- Normal code changes with no security implications → SAFE

Context: You see the diff, and when available, the full contents of changed files in [FILE CONTEXT] blocks. Use file context to:
- Trace data flows through functions surrounding the changed lines.
- Check whether new external calls use existing validated patterns.
- Identify if security controls (auth checks, input validation) exist in the broader file that cover the changed code.
- Spot if a change removes protection that the surrounding code depends on.

When file context is not provided, or for files without context blocks, note the uncertainty explicitly in the risk description rather than defaulting to UNSAFE.

Use [FILE HINTS] to calibrate risk — hardcoded values in test/fixture files are lower risk than in production files. Use [FILE CONTEXT] blocks (when present) for deeper analysis — trace data flows, check surrounding security controls, and validate that changes are consistent with the file's existing patterns.

[COMMENT CHECK] is a deterministic pre-pass that flags AI-generated comment noise (operation narration, meta markers, trivial docblocks). Mirror each flagged comment as a LOW-risk item in the risks array so the user sees it, but DO NOT flip the verdict to UNSAFE based on comment noise alone. Security findings still drive the verdict.

Be strict. When in doubt, lean toward UNSAFE. False positives are acceptable; false negatives are not.`;

// Re-export for caller convenience
export type { AuditorFileContext } from './auditor-file-context.js';

function formatFileContextBlock(contexts: AuditorFileContext[]): string {
  if (contexts.length === 0) return '';
  const blocks = contexts.map((ctx) => {
    const truncNote = ctx.truncated ? ' [truncated]' : '';
    return `[FILE CONTEXT: ${ctx.path}]${truncNote}\n${ctx.content}\n[/FILE CONTEXT: ${ctx.path}]`;
  });
  return blocks.join('\n\n') + '\n\n';
}

export async function runAuditor(
  diff: string,
  options: AuditorRunOptions,
  onStatus: (phase: string) => void,
): Promise<AuditResult> {
  const key = auditCoalesceKey(
    options.stream,
    diff,
    options.provider,
    options.modelId,
    JSON.stringify(options.context ?? null),
    options.hookResult,
    options.fileContexts,
  );

  const inflight = pendingAudits.get(key);
  if (inflight) {
    addAuditListener(key, onStatus);
    return inflight;
  }

  const listeners = new Set([onStatus]);
  auditListeners.set(key, listeners);

  const run = (async () => {
    const runtimeContext = await options.resolveRuntimeContext(diff, options.context);
    return runAuditorCore(
      diff,
      (phase) => {
        broadcastAuditStatus(key, phase);
      },
      options,
      runtimeContext,
    );
  })();
  pendingAudits.set(key, run);
  run.finally(() => {
    pendingAudits.delete(key);
    auditListeners.delete(key);
    auditLatestPhase.delete(key);
  });
  return run;
}

async function runAuditorCore(
  diff: string,
  onStatus: (phase: string) => void,
  options: AuditorRunOptions,
  runtimeContext?: string,
): Promise<{ verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData }> {
  const filesReviewed = parseDiffStats(diff).filesChanged;

  // Fail-safe: require an active AI provider with a valid key
  if (options.provider === 'demo' || !options.stream) {
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'No AI provider configured. Cannot run Auditor.',
        risks: [
          { level: 'high', description: 'Add an API key in Settings — defaulting to UNSAFE' },
        ],
        filesReviewed,
      },
    };
  }

  const stream = options.stream;
  const modelId = options.modelId?.trim();
  if (!modelId) {
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'Auditor configuration error: missing model id',
        risks: [{ level: 'high', description: 'Auditor failed — defaulting to UNSAFE' }],
        filesReviewed,
      },
    };
  }
  const contextBlock = runtimeContext ?? '';
  const promptBuilder = new SystemPromptBuilder()
    .set('identity', AUDITOR_SYSTEM_PROMPT)
    .set('environment', contextBlock);
  const systemPrompt = promptBuilder.build();

  // Single-shot prompt snapshot for Auditor. Hashes + sizes only.
  options.onRunEvent?.({
    type: 'assistant.prompt_snapshot',
    round: 0,
    role: 'auditor',
    totalChars: systemPrompt.length,
    sections: promptBuilder.snapshot(),
  });

  onStatus('Auditor reviewing...');

  // Chunk diff by file, prioritizing production files
  const DIFF_LIMIT = SIZE_BUDGETS.auditorDiffChunk;
  const chunkedDiff = chunkDiffByFile(diff, DIFF_LIMIT, classifyFilePath);

  // Build [FILE HINTS] block from the chunked diff (not the raw diff) so the
  // model only sees classifications for files whose hunks are actually included.
  const fileHintPaths = [...chunkedDiff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((m) => m[1]);
  const fileHintsBlock =
    fileHintPaths.length > 0
      ? `[FILE HINTS]\n${fileHintPaths.map((p) => `- ${p}: ${classifyFilePath(p)}`).join('\n')}\n[/FILE HINTS]\n\n`
      : '';

  const fileContextBlock = formatFileContextBlock(options.fileContexts ?? []);

  // Pre-compute the pre-commit hook signal once so every return path can
  // surface it — the gate must be visible whether the model verdict parses,
  // the stream errors, or the JSON is malformed. All three paths already
  // return UNSAFE; this keeps a failing hook from being masked behind a
  // generic "Auditor error" card (an operator would otherwise retry, reading
  // it as a transient stream blip rather than their broken hook).
  const hookExitCode = options.hookResult?.exitCode ?? 0;
  const hookFailed = hookExitCode !== 0;
  const hookRisk: { level: 'high'; description: string }[] = hookFailed
    ? [
        {
          level: 'high',
          description: `Pre-commit hook failed (exit code ${hookExitCode}) — blocking commit`,
        },
      ]
    : [];
  const hookSummarySuffix = hookFailed
    ? ` Pre-commit hook failed (exit code ${hookExitCode}).`
    : '';

  // Deterministic pre-pass — flags AI comment noise on added lines. Findings
  // are rendered as a [COMMENT CHECK] block the Auditor mirrors as low-risk
  // items without flipping the verdict.
  const commentFindings = detectAiCommentPatterns(chunkedDiff);
  const commentCheckBlock = formatCommentCheckBlock(commentFindings);
  const commentCheckSection = commentCheckBlock ? `${commentCheckBlock}\n\n` : '';

  const messages: LlmMessage[] = [
    {
      id: 'audit-request',
      role: 'user',
      content: `Review this diff for security issues:\n\n${fileHintsBlock}${commentCheckSection}${fileContextBlock}\`\`\`diff\n${chunkedDiff.replace(/`/g, '\\`')}\n\`\`\`${options.hookResult ? `\n\n[PRE-COMMIT HOOK RESULT]\nExit Code: ${options.hookResult.exitCode}\nOutput:\n${options.hookResult.output}\n\nIf non-zero, you MUST return UNSAFE...\n[/PRE-COMMIT HOOK RESULT]` : ''}`,
      timestamp: Date.now(),
    },
  ];

  // Native structured outputs: constrain the verdict JSON server-side when the
  // model supports it. parseStructured still validates the result below — this
  // raises the floor on conformance, it doesn't replace the backstop.
  const structuredOutput = applyStructuredOutput(
    options.supportsStructuredOutput === true,
    AUDITOR_VERDICT_RESPONSE_FORMAT,
    { eventBase: 'auditor_structured_output', provider: options.provider, model: modelId },
  );

  const { error: streamError, text: accumulated } = await iteratePushStreamText(
    stream,
    {
      provider: options.provider,
      model: modelId,
      messages,
      systemPromptOverride: systemPrompt,
      hasSandbox: false,
      ...structuredOutput,
    },
    AUDITOR_TIMEOUT_MS,
    `Auditor timed out after ${AUDITOR_TIMEOUT_MS / 1000}s — model may be unresponsive.`,
  );

  if (streamError) {
    // Error → fail-safe to unsafe
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: `Auditor error: ${streamError.message}${hookSummarySuffix}`,
        risks: [
          ...hookRisk,
          { level: 'high', description: 'Auditor failed — defaulting to UNSAFE' },
        ],
        filesReviewed,
      },
    };
  }

  // Parse + validate the verdict JSON. parseStructured strips a markdown
  // fence, repairs common LLM garbling, and validates against the schema;
  // the schema's per-field `.catch` defaults reproduce the inline coercion
  // this site used to do by hand.
  const parseResult = parseStructured(accumulated, AuditorVerdictSchema);

  if (!parseResult.ok) {
    // Close the formerly-silent catch{} path with a structured log, then
    // fail-safe to UNSAFE.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'auditor_verdict_parse_failed',
        reason: parseResult.reason,
        provider: options.provider,
        model: modelId,
      }),
    );
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: `Auditor returned invalid response. Defaulting to UNSAFE.${hookSummarySuffix}`,
        risks: [
          ...hookRisk,
          { level: 'high', description: 'Could not parse Auditor verdict — blocking commit' },
        ],
        filesReviewed,
      },
    };
  }

  const { verdict: modelVerdict, summary, risks } = parseResult.data;

  // Runtime-enforced gate: a non-zero pre-commit hook exit code forces
  // UNSAFE regardless of the model's verdict (hookFailed/hookRisk computed
  // above). The prompt instructs the model to do this, but enforcement must
  // live in code — a non-cooperating model could otherwise return SAFE past
  // a failing hook.
  const verdict: 'safe' | 'unsafe' = hookFailed ? 'unsafe' : modelVerdict;
  const cardRisks = [...hookRisk, ...risks];

  return {
    verdict,
    card: { verdict, summary, risks: cardRisks, filesReviewed },
  };
}

// ---------------------------------------------------------------------------
// Evaluation mode — post-Coder completeness assessment
// ---------------------------------------------------------------------------

const EVALUATION_TIMEOUT_MS = 60_000;

export interface EvaluationResult {
  verdict: 'complete' | 'incomplete';
  summary: string;
  /** Specific items that are incomplete or missing. */
  gaps: string[];
  /** Confidence level in the verdict. */
  confidence: 'high' | 'medium' | 'low';
}

// The Evaluator's subject — a delegated Coder's output, or the inline lead's
// own turn. Keeping it a parameter (rather than two prompt copies) means the
// verdict the model writes back never calls the conversational lead "the
// Coder" (the leak surfaced in the round-cap screenshot).
function buildEvaluationSystemPrompt(subject: string): string {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return `You are the Evaluator for Push, a mobile AI coding assistant. Your job is to assess whether ${subject}'s work is complete.

You receive:
1. The original task description
2. ${Subject}'s final summary of what it did
3. ${Subject}'s working memory (plan, completed phases, errors, files touched)
4. A diff of sandbox changes (if available)
5. The runtime tool ledger (accepted/rejected calls and recorded outcomes)

You MUST respond with ONLY a valid JSON object. No other text.

Schema:
{
  "verdict": "complete" | "incomplete",
  "summary": "One sentence explaining your assessment",
  "gaps": ["Specific items that are missing or incomplete"],
  "confidence": "high" | "medium" | "low"
}

Evaluation criteria:
- Did ${subject} address the core intent of the task?
- Are there open tasks remaining in the working memory?
- Did ${subject} encounter errors that were never resolved?
- Does the diff show the expected changes (files created/modified)?
- If acceptance criteria were provided, did they pass?
- Did ${subject} hit a round cap or drift, suggesting premature termination?

Important:
- Be honest. Do NOT rubber-stamp incomplete work.
- "complete" means the task's core deliverable is done, not that it's perfect.
- Minor polish or optimization gaps do not make a task "incomplete".
- If ${subject} was stopped by a circuit breaker (round cap, drift), default to "incomplete" unless the summary clearly shows the work was finished before the stop.
- If you lack enough context to judge, set confidence to "low" rather than guessing.`;
}

export async function runAuditorEvaluation(
  task: string,
  coderSummary: string,
  workingMemory: CoderWorkingMemory | null,
  diff: string | null,
  options: AuditorEvaluationOptions,
  onStatus: (phase: string) => void,
): Promise<EvaluationResult> {
  // Fail-safe default
  const INCOMPLETE_DEFAULT: EvaluationResult = {
    verdict: 'incomplete',
    summary: 'Evaluation could not be completed — defaulting to incomplete.',
    gaps: ['Evaluation failed'],
    confidence: 'low',
  };

  if (options.provider === 'demo' || !options.stream) {
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'No AI provider configured. Cannot run evaluation.',
    };
  }

  const stream = options.stream;
  const modelId = options.modelId?.trim();
  if (!modelId) {
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'Evaluation configuration error: missing model id',
    };
  }

  // Subject vocabulary: the delegated Coder vs. the inline conversational lead.
  const subject = options.leadMode ? 'the assistant' : 'the Coder';
  const summaryLabel = options.leadMode ? 'SUMMARY' : 'CODER SUMMARY';

  onStatus(options.leadMode ? 'Evaluating output...' : 'Evaluating Coder output...');

  // Build the evaluation request
  const sections: string[] = [
    `[ORIGINAL TASK]\n${task}\n[/ORIGINAL TASK]`,
    `[${summaryLabel}]\n${coderSummary}\n[/${summaryLabel}]`,
  ];

  const retrievedMemoryBlock =
    (await options.resolveEvaluationMemoryBlock?.(task, diff, options.memoryScope)) ?? null;
  if (retrievedMemoryBlock) {
    sections.push(retrievedMemoryBlock);
  }

  if (workingMemory) {
    // Reuse the canonical formatCoderState to ensure all fields (including
    // assumptions, observations, etc.) are included in the evaluation context.
    sections.push(
      `[WORKING MEMORY]\n${formatCoderState(workingMemory, options?.coderRounds || 0)}\n[/WORKING MEMORY]`,
    );
  }

  if (options.toolLedgerContext) {
    sections.push(`[TOOL LEDGER]\n${options.toolLedgerContext}\n[/TOOL LEDGER]`);
  }

  if (options?.coderRounds !== undefined && options?.coderMaxRounds !== undefined) {
    const hitCap = options.coderRounds >= options.coderMaxRounds;
    sections.push(
      `[EXECUTION INFO]\nRounds used: ${options.coderRounds}/${options.coderMaxRounds}${hitCap ? ' (HIT ROUND CAP — may be premature termination)' : ''}\n[/EXECUTION INFO]`,
    );
  }

  if (options?.criteriaResults?.length) {
    const passed = options.criteriaResults.filter((r) => r.passed).length;
    const total = options.criteriaResults.length;
    const lines = options.criteriaResults.map(
      (r) =>
        `  ${r.passed ? 'PASS' : 'FAIL'} ${r.id}${r.passed ? '' : `: ${r.output.slice(0, 200)}`}`,
    );
    sections.push(
      `[ACCEPTANCE CRITERIA] ${passed}/${total} passed\n${lines.join('\n')}\n[/ACCEPTANCE CRITERIA]`,
    );
  }

  // Session-level verification policy — gives the auditor awareness of
  // what verification rules the session expects so it can flag gaps.
  // The `auditor-gate` rule is dropped because this IS the auditor run; the
  // LLM otherwise reads its own gate as an unmet precondition and returns
  // an incomplete verdict.
  const policyBlock = formatVerificationPolicyBlock(options?.verificationPolicy, {
    excludeGate: 'auditor',
  });
  if (policyBlock) {
    sections.push(policyBlock);
  }

  if (diff) {
    const truncatedDiff =
      diff.length > SIZE_BUDGETS.auditorDiff
        ? diff.slice(0, SIZE_BUDGETS.auditorDiff) + '\n[diff truncated]'
        : diff;
    sections.push(
      `[SANDBOX DIFF]\n\`\`\`diff\n${truncatedDiff.replace(/`/g, '\\`')}\n\`\`\`\n[/SANDBOX DIFF]`,
    );
  }

  const messages: LlmMessage[] = [
    {
      id: 'eval-request',
      role: 'user',
      content: `Evaluate whether ${subject}'s work is complete:\n\n${sections.join('\n\n')}`,
      timestamp: Date.now(),
    },
  ];

  const structuredOutput = applyStructuredOutput(
    options.supportsStructuredOutput === true,
    AUDITOR_EVALUATION_RESPONSE_FORMAT,
    {
      eventBase: 'auditor_evaluation_structured_output',
      provider: options.provider,
      model: modelId,
    },
  );

  const { error: streamError, text: accumulated } = await iteratePushStreamText(
    stream,
    {
      provider: options.provider,
      model: modelId,
      messages,
      systemPromptOverride: buildEvaluationSystemPrompt(subject),
      hasSandbox: false,
      ...structuredOutput,
    },
    EVALUATION_TIMEOUT_MS,
    `Evaluation timed out after ${EVALUATION_TIMEOUT_MS / 1000}s.`,
  );

  if (streamError) {
    return { ...INCOMPLETE_DEFAULT, summary: `Evaluation error: ${streamError.message}` };
  }

  // Parse + validate the evaluation JSON (schema `.catch` defaults mirror the
  // inline coercion this site used to do).
  const parseResult = parseStructured(accumulated, AuditorEvaluationSchema);

  if (!parseResult.ok) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'auditor_evaluation_parse_failed',
        reason: parseResult.reason,
        provider: options.provider,
        model: modelId,
      }),
    );
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'Evaluator returned invalid response. Defaulting to incomplete.',
    };
  }

  return parseResult.data;
}
