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

import type { ChatMessage, AuditVerdictCardData, CoderWorkingMemory } from '@/types';
import { getActiveProvider, getProviderStreamFn, type ActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';
import { buildAuditorContextBlock, type AuditorPromptContext } from './role-context';
import { formatCoderState } from './coder-agent';

import { asRecord, streamWithTimeout } from './utils';
import { parseDiffStats, chunkDiffByFile, classifyFilePath } from './diff-utils';

const AUDITOR_TIMEOUT_MS = 60_000; // 60s max for auditor review

export interface HookResult {
  exitCode: number;
  output: string;
}

export interface AuditorRunOptions {
  providerOverride?: ActiveProvider;
  modelOverride?: string | null;
}

// ---------------------------------------------------------------------------
// Coalesced promise — dedup concurrent audits on the same diff+provider+context
// ---------------------------------------------------------------------------
type AuditResult = { verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData };
const pendingAudits = new Map<string, Promise<AuditResult>>();
const auditListeners = new Map<string, Set<(phase: string) => void>>();
const auditLatestPhase = new Map<string, string>();

function auditCoalesceKey(
  diff: string,
  provider: string,
  modelId: string | undefined,
  runtimeContext: string,
  hookResult?: HookResult | null,
): string {
  return JSON.stringify({
    provider,
    modelId: modelId ?? '',
    runtimeContext,
    hookResult: hookResult
      ? {
        exitCode: hookResult.exitCode,
        output: hookResult.output,
      }
      : null,
    diff,
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
- Normal code changes with no security implications → SAFE

Context limitation: You only see the diff plus any runtime context block appended below, not the full codebase. Where your assessment depends on broader context you cannot see, note the uncertainty explicitly in the risk description rather than defaulting to UNSAFE.

Use [FILE HINTS] to calibrate risk — hardcoded values in test/fixture files are lower risk than in production files.

Be strict. When in doubt, lean toward UNSAFE. False positives are acceptable; false negatives are not.`;

export async function runAuditor(
  diff: string,
  onStatus: (phase: string) => void,
  context?: AuditorPromptContext,
  hookResult?: HookResult | null,
  options?: AuditorRunOptions,
): Promise<AuditResult> {
  const provider = (options?.providerOverride || getActiveProvider()) as string;
  const modelId = options?.modelOverride?.trim() || getModelForRole(provider as ActiveProvider, 'auditor')?.id;
  const runtimeContext = buildAuditorContextBlock(context);
  const key = auditCoalesceKey(diff, provider, modelId, runtimeContext, hookResult);

  const inflight = pendingAudits.get(key);
  if (inflight) {
    addAuditListener(key, onStatus);
    return inflight;
  }

  const listeners = new Set([onStatus]);
  auditListeners.set(key, listeners);

  const run = runAuditorCore(diff, (phase) => {
    broadcastAuditStatus(key, phase);
  }, context, hookResult, {
    ...options,
    providerOverride: provider as ActiveProvider,
    modelOverride: modelId,
  }, runtimeContext);
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
  context?: AuditorPromptContext,
  hookResult?: HookResult | null,
  options?: AuditorRunOptions,
  runtimeContext?: string,
): Promise<{ verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData }> {
  const filesReviewed = parseDiffStats(diff).filesChanged;

  // Fail-safe: require an active AI provider with a valid key
  const activeProvider = options?.providerOverride || getActiveProvider();
  if (activeProvider === 'demo') {
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'No AI provider configured. Cannot run Auditor.',
        risks: [{ level: 'high', description: 'Add an API key in Settings — defaulting to UNSAFE' }],
        filesReviewed,
      },
    };
  }

  const { streamFn } = getProviderStreamFn(activeProvider);
  const auditorModelId = options?.modelOverride?.trim() || getModelForRole(activeProvider, 'auditor')?.id; // undefined falls back to provider default
  const contextBlock = runtimeContext ?? buildAuditorContextBlock(context);
  const systemPrompt = contextBlock
    ? `${AUDITOR_SYSTEM_PROMPT}\n\n${contextBlock}`
    : AUDITOR_SYSTEM_PROMPT;

  onStatus('Auditor reviewing...');

  // Chunk diff by file, prioritizing production files
  const DIFF_LIMIT = 30_000;
  const chunkedDiff = chunkDiffByFile(diff, DIFF_LIMIT, classifyFilePath);

  // Build [FILE HINTS] block from the chunked diff (not the raw diff) so the
  // model only sees classifications for files whose hunks are actually included.
  const fileHintPaths = [...chunkedDiff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((m) => m[1]);
  const fileHintsBlock = fileHintPaths.length > 0
    ? `[FILE HINTS]\n${fileHintPaths.map((p) => `- ${p}: ${classifyFilePath(p)}`).join('\n')}\n[/FILE HINTS]\n\n`
    : '';

  const messages: ChatMessage[] = [
    {
      id: 'audit-request',
      role: 'user',
      content: `Review this diff for security issues:\n\n${fileHintsBlock}\`\`\`diff\n${chunkedDiff.replace(/`/g, '\\`')}\n\`\`\`${hookResult ? `\n\n[PRE-COMMIT HOOK RESULT]\nExit Code: ${hookResult.exitCode}\nOutput:\n${hookResult.output}\n\nIf non-zero, you MUST return UNSAFE...\n[/PRE-COMMIT HOOK RESULT]` : ''}`,
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
        false,     // no sandbox
        auditorModelId,
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
        risks: [{ level: 'high', description: 'Could not parse Auditor verdict — blocking commit' }],
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
  onStatus: (phase: string) => void,
  options?: AuditorRunOptions & {
    coderRounds?: number;
    coderMaxRounds?: number;
    criteriaResults?: { id: string; passed: boolean; output: string }[];
  },
): Promise<EvaluationResult> {
  // Fail-safe default
  const INCOMPLETE_DEFAULT: EvaluationResult = {
    verdict: 'incomplete',
    summary: 'Evaluation could not be completed — defaulting to incomplete.',
    gaps: ['Evaluation failed'],
    confidence: 'low',
  };

  const activeProvider = options?.providerOverride || getActiveProvider();
  if (activeProvider === 'demo') {
    return {
      ...INCOMPLETE_DEFAULT,
      summary: 'No AI provider configured. Cannot run evaluation.',
    };
  }

  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'auditor');
  const auditorModelId = options?.modelOverride?.trim() || roleModel?.id;

  onStatus('Evaluating Coder output...');

  // Build the evaluation request
  const sections: string[] = [
    `[ORIGINAL TASK]\n${task}\n[/ORIGINAL TASK]`,
    `[CODER SUMMARY]\n${coderSummary}\n[/CODER SUMMARY]`,
  ];

  if (workingMemory) {
    // Reuse the canonical formatCoderState to ensure all fields (including
    // assumptions, observations, etc.) are included in the evaluation context.
    sections.push(`[WORKING MEMORY]\n${formatCoderState(workingMemory, options?.coderRounds || 0)}\n[/WORKING MEMORY]`);
  }

  if (options?.coderRounds !== undefined && options?.coderMaxRounds !== undefined) {
    const hitCap = options.coderRounds >= options.coderMaxRounds;
    sections.push(`[EXECUTION INFO]\nRounds used: ${options.coderRounds}/${options.coderMaxRounds}${hitCap ? ' (HIT ROUND CAP — may be premature termination)' : ''}\n[/EXECUTION INFO]`);
  }

  if (options?.criteriaResults?.length) {
    const passed = options.criteriaResults.filter(r => r.passed).length;
    const total = options.criteriaResults.length;
    const lines = options.criteriaResults.map(r =>
      `  ${r.passed ? 'PASS' : 'FAIL'} ${r.id}${r.passed ? '' : `: ${r.output.slice(0, 200)}`}`,
    );
    sections.push(`[ACCEPTANCE CRITERIA] ${passed}/${total} passed\n${lines.join('\n')}\n[/ACCEPTANCE CRITERIA]`);
  }

  if (diff) {
    const truncatedDiff = diff.length > 15_000 ? diff.slice(0, 15_000) + '\n[diff truncated]' : diff;
    sections.push(`[SANDBOX DIFF]\n\`\`\`diff\n${truncatedDiff.replace(/`/g, '\\`')}\n\`\`\`\n[/SANDBOX DIFF]`);
  }

  const messages: ChatMessage[] = [
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
        auditorModelId,
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
    const verdict: 'complete' | 'incomplete' = parsed?.verdict === 'complete' ? 'complete' : 'incomplete';
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : 'No summary provided';
    const gaps = Array.isArray(parsed?.gaps)
      ? (parsed.gaps as unknown[]).filter((g): g is string => typeof g === 'string')
      : [];
    const confidence: 'high' | 'medium' | 'low' =
      parsed?.confidence === 'high' || parsed?.confidence === 'medium' || parsed?.confidence === 'low'
        ? parsed.confidence
        : 'low';

    return { verdict, summary, gaps, confidence };
  } catch {
    return { ...INCOMPLETE_DEFAULT, summary: 'Evaluator returned invalid response. Defaulting to incomplete.' };
  }
}
