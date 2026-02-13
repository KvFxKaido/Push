/**
 * Auditor Agent — reviews diffs for safety before allowing commits.
 *
 * Uses the active provider (Kimi / Ollama / Mistral) with the role-specific
 * model resolved via providers.ts. This ensures the Auditor works with
 * whichever backend the user has configured.
 *
 * Design: fail-safe. If the Auditor returns invalid JSON or errors,
 * the verdict defaults to UNSAFE (blocking the commit).
 */

import type { ChatMessage, AuditVerdictCardData } from '@/types';
import { getActiveProvider, getProviderStreamFn } from './orchestrator';
import { getModelForRole } from './providers';

import { asRecord, streamWithTimeout } from './utils';

const AUDITOR_TIMEOUT_MS = 60_000; // 60s max for auditor review

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
- Suspicious network calls to unknown endpoints → UNSAFE (high)
- Disabled security features (CORS, auth checks) → UNSAFE (high)
- SQL injection, XSS, command injection vectors → UNSAFE (high)
- Overly broad file permissions → UNSAFE (medium)
- Missing input validation on user-facing code → UNSAFE (medium)
- Dead code or debug artifacts (console.log) → SAFE but note as low risk
- Normal code changes with no security implications → SAFE

Be strict. When in doubt, lean toward UNSAFE. False positives are acceptable; false negatives are not.`;

function parseDiffFileCount(diff: string): number {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) files.add(match[1]);
    }
  }
  return files.size;
}

export async function runAuditor(
  diff: string,
  onStatus: (phase: string) => void,
): Promise<{ verdict: 'safe' | 'unsafe'; card: AuditVerdictCardData }> {
  const filesReviewed = parseDiffFileCount(diff);

  // Fail-safe: require an active AI provider with a valid key
  const activeProvider = getActiveProvider();
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
  const roleModel = getModelForRole(activeProvider, 'auditor');
  const auditorModelId = roleModel?.id; // undefined falls back to provider default

  onStatus('Auditor reviewing...');

  const messages: ChatMessage[] = [
    {
      id: 'audit-request',
      role: 'user',
      content: `Review this diff for security issues:\n\n\`\`\`diff\n${diff.slice(0, 15_000)}\n\`\`\``,
      timestamp: Date.now(),
    },
  ];

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    AUDITOR_TIMEOUT_MS,
    `Auditor timed out after ${AUDITOR_TIMEOUT_MS / 1000}s — model may be unresponsive.`,
    (onToken, onDone, onError) => {
      streamFn(
        messages,
        onToken,
        onDone,
        onError,
        undefined, // no thinking tokens
        undefined, // no workspace context
        false,     // no sandbox
        auditorModelId,
        AUDITOR_SYSTEM_PROMPT,
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
