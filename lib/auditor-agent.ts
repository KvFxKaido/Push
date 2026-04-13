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

import type { AIProviderType, LlmMessage, ProviderStreamFn } from './provider-contract.js';
import type { MemoryScope } from './runtime-contract.js';
import type { AuditorPromptContext } from './role-context.js';
import { formatCoderState, type CoderWorkingMemory } from './working-memory.js';
import { asRecord, streamWithTimeout } from './stream-utils.js';
import { parseDiffStats, chunkDiffByFile, classifyFilePath } from './diff-utils.js';
import { detectAiCommentPatterns, formatCommentCheckBlock } from './comment-check.js';
import type { AuditorFileContext } from './auditor-file-context.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import { formatVerificationPolicyBlock, type VerificationPolicy } from './verification-policy.js';

const AUDITOR_TIMEOUT_MS = 90_000; // 90s — allows for richer file-context processing

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
  streamFn?: ProviderStreamFn;
  modelId?: string;
  context?: AuditorPromptContext;
  hookResult?: HookResult | null;
  fileContexts?: AuditorFileContext[];
  resolveRuntimeContext: ResolveAuditorRuntimeContextFn;
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
  streamFn?: ProviderStreamFn;
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
}

// ---------------------------------------------------------------------------
// Coalesced promise — dedup concurrent audits on the same diff+provider+context
// ---------------------------------------------------------------------------
export type AuditResult = { verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData };
const pendingAudits = new Map<string, Promise<AuditResult>>();
const auditListeners = new Map<string, Set<(phase: string) => void>>();
const auditLatestPhase = new Map<string, string>();

const streamFnIds = new WeakMap<ProviderStreamFn, number>();
let nextStreamFnId = 0;

function getStreamFnId(streamFn: ProviderStreamFn | undefined): number | null {
  if (!streamFn) return null;
  let id = streamFnIds.get(streamFn);
  if (id === undefined) {
    id = nextStreamFnId++;
    streamFnIds.set(streamFn, id);
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
  streamFn: ProviderStreamFn | undefined,
  diff: string,
  provider: string,
  modelId: string | undefined,
  runtimeContext: string,
  hookResult?: HookResult | null,
  fileContexts?: AuditorFileContext[],
): string {
  return JSON.stringify({
    streamFnId: getStreamFnId(streamFn),
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
    options.streamFn,
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
  if (options.provider === 'demo' || !options.streamFn) {
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

  const streamFn = options.streamFn;
  const contextBlock = runtimeContext ?? '';
  const systemPrompt = new SystemPromptBuilder()
    .set('identity', AUDITOR_SYSTEM_PROMPT)
    .set('environment', contextBlock)
    .build();

  onStatus('Auditor reviewing...');

  // Chunk diff by file, prioritizing production files
  const DIFF_LIMIT = 30_000;
  const chunkedDiff = chunkDiffByFile(diff, DIFF_LIMIT, classifyFilePath);

  // Build [FILE HINTS] block from the chunked diff (not the raw diff) so the
  // model only sees classifications for files whose hunks are actually included.
  const fileHintPaths = [...chunkedDiff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((m) => m[1]);
  const fileHintsBlock =
    fileHintPaths.length > 0
      ? `[FILE HINTS]\n${fileHintPaths.map((p) => `- ${p}: ${classifyFilePath(p)}`).join('\n')}\n[/FILE HINTS]\n\n`
      : '';

  const fileContextBlock = formatFileContextBlock(options.fileContexts ?? []);

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

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    AUDITOR_TIMEOUT_MS,
    `Auditor timed out after ${AUDITOR_TIMEOUT_MS / 1000}s — model may be unresponsive.`,
    (onToken, onDone, onError) => {
      return streamFn(
        messages,
        onToken,
        onDone,
        onError,
        undefined, // no thinking tokens
        undefined, // no workspace context
        false, // no sandbox
        options.modelId,
        systemPrompt,
      );
    },
  );
  const streamError = await streamErrorPromise;
  const accumulated = getAccumulated();

  if (streamError) {
    // Error → fail-safe to unsafe
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: `Auditor error: ${streamError.message}`,
        risks: [{ level: 'high', description: 'Auditor failed — defaulting to UNSAFE' }],
        filesReviewed,
      },
    };
  }

  // Parse JSON from response
  try {
    // The response might have markdown code fences around it
    let jsonStr = accumulated.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = asRecord(JSON.parse(jsonStr));
    const parsedVerdict = parsed?.verdict;
    const parsedSummary = parsed?.summary;
    const parsedRisks = parsed?.risks;

    const verdict: 'safe' | 'unsafe' = parsedVerdict === 'safe' ? 'safe' : 'unsafe';
    const summary = typeof parsedSummary === 'string' ? parsedSummary : 'No summary provided';
    const risks = Array.isArray(parsedRisks)
      ? parsedRisks.map((risk) => {
          const r = asRecord(risk);
          const level = r?.level;
          const description = r?.description;
          const riskLevel: 'low' | 'medium' | 'high' =
            level === 'low' || level === 'medium' || level === 'high' ? level : 'medium';
          return {
            level: riskLevel,
            description: typeof description === 'string' ? description : 'Unknown risk',
          };
        })
      : [];

    return {
      verdict,
      card: { verdict, summary, risks, filesReviewed },
    };
  } catch {
    // Invalid JSON → fail-safe to unsafe
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'Auditor returned invalid response. Defaulting to UNSAFE.',
        risks: [
          { level: 'high', description: 'Could not parse Auditor verdict — blocking commit' },
        ],
        filesReviewed,
      },
    };
  }
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

const EVALUATION_SYSTEM_PROMPT = `You are the Evaluator for Push, a mobile AI coding assistant. Your job is to assess whether a Coder agent's work is complete.

You receive:
1. The original task description
2. The Coder's final summary of what it did
3. The Coder's working memory (plan, completed phases, errors, files touched)
4. A diff of sandbox changes (if available)

You MUST respond with ONLY a valid JSON object. No other text.

Schema:
{
  "verdict": "complete" | "incomplete",
  "summary": "One sentence explaining your assessment",
  "gaps": ["Specific items that are missing or incomplete"],
  "confidence": "high" | "medium" | "low"
}

Evaluation criteria:
- Did the Coder address the core intent of the task?
- Are there open tasks remaining in the working memory?
- Did the Coder encounter errors that were never resolved?
- Does the diff show the expected changes (files created/modified)?
- If acceptance criteria were provided, did they pass?
- Did the Coder hit a round cap or drift, suggesting premature termination?

Important:
- Be honest. Do NOT rubber-stamp incomplete work.
- "complete" means the task's core deliverable is done, not that it's perfect.
- Minor polish or optimization gaps do not make a task "incomplete".
- If the Coder was stopped by a circuit breaker (round cap, drift), default to "incomplete" unless the summary clearly shows the work was finished before the stop.
- If you lack enough context to judge, set confidence to "low" rather than guessing.`;

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

  if (options.provider === 'demo' || !options.streamFn) {
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'No AI provider configured. Cannot run evaluation.',
    };
  }

  const streamFn = options.streamFn;

  onStatus('Evaluating Coder output...');

  // Build the evaluation request
  const sections: string[] = [
    `[ORIGINAL TASK]\n${task}\n[/ORIGINAL TASK]`,
    `[CODER SUMMARY]\n${coderSummary}\n[/CODER SUMMARY]`,
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
  const policyBlock = formatVerificationPolicyBlock(options?.verificationPolicy);
  if (policyBlock) {
    sections.push(policyBlock);
  }

  if (diff) {
    const truncatedDiff =
      diff.length > 15_000 ? diff.slice(0, 15_000) + '\n[diff truncated]' : diff;
    sections.push(
      `[SANDBOX DIFF]\n\`\`\`diff\n${truncatedDiff.replace(/`/g, '\\`')}\n\`\`\`\n[/SANDBOX DIFF]`,
    );
  }

  const messages: LlmMessage[] = [
    {
      id: 'eval-request',
      role: 'user',
      content: `Evaluate whether the Coder's work is complete:\n\n${sections.join('\n\n')}`,
      timestamp: Date.now(),
    },
  ];

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    EVALUATION_TIMEOUT_MS,
    `Evaluation timed out after ${EVALUATION_TIMEOUT_MS / 1000}s.`,
    (onToken, onDone, onError) => {
      return streamFn(
        messages,
        onToken,
        onDone,
        onError,
        undefined,
        undefined,
        false,
        options.modelId,
        EVALUATION_SYSTEM_PROMPT,
      );
    },
  );
  const streamError = await streamErrorPromise;
  const accumulated = getAccumulated();

  if (streamError) {
    return { ...INCOMPLETE_DEFAULT, summary: `Evaluation error: ${streamError.message}` };
  }

  // Parse JSON response
  try {
    let jsonStr = accumulated.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = asRecord(JSON.parse(jsonStr));
    const verdict: 'complete' | 'incomplete' =
      parsed?.verdict === 'complete' ? 'complete' : 'incomplete';
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : 'No summary provided';
    const gaps = Array.isArray(parsed?.gaps)
      ? (parsed.gaps as unknown[]).filter((g): g is string => typeof g === 'string')
      : [];
    const confidence: 'high' | 'medium' | 'low' =
      parsed?.confidence === 'high' ||
      parsed?.confidence === 'medium' ||
      parsed?.confidence === 'low'
        ? parsed.confidence
        : 'low';

    return { verdict, summary, gaps, confidence };
  } catch {
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'Evaluator returned invalid response. Defaulting to incomplete.',
    };
  }
}
