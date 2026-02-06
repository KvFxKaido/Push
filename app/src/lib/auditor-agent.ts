/**
 * Auditor Agent — reviews diffs for safety before allowing commits.
 *
 * Uses Kimi K2 Thinking via Moonshot. Produces a binary verdict:
 * SAFE or UNSAFE, plus a structured risk assessment.
 *
 * Design: fail-safe. If the Auditor returns invalid JSON or errors,
 * the verdict defaults to UNSAFE (blocking the commit).
 */

import type { ChatMessage, AuditVerdictCardData } from '@/types';
import { streamMoonshotChat, streamOllamaChat, getActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';

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
  const provider = getActiveProvider();
  const providerType = provider === 'ollama' ? 'ollama' : 'moonshot';
  const streamFn = provider === 'ollama' ? streamOllamaChat : streamMoonshotChat;

  const auditorModel = getModelForRole(providerType, 'auditor');
  if (!auditorModel) {
    // No auditor model → fail-safe to unsafe
    return {
      verdict: 'unsafe',
      card: {
        verdict: 'unsafe',
        summary: 'Auditor model not configured. Cannot verify safety.',
        risks: [{ level: 'high', description: 'No auditor available — defaulting to UNSAFE' }],
        filesReviewed: 0,
      },
    };
  }

  const filesReviewed = parseDiffFileCount(diff);

  onStatus('Auditor reviewing...');

  const messages: ChatMessage[] = [
    {
      id: 'audit-request',
      role: 'user',
      content: `Review this diff for security issues:\n\n\`\`\`diff\n${diff.slice(0, 15_000)}\n\`\`\``,
      timestamp: Date.now(),
    },
  ];

  let accumulated = '';

  const streamError = await new Promise<Error | null>((resolve) => {
    streamFn(
      messages,
      (token) => { accumulated += token; },
      () => resolve(null),
      (error) => resolve(error),
      undefined, // no thinking tokens
      undefined, // no workspace context
      false,     // no sandbox
      auditorModel.id,
      AUDITOR_SYSTEM_PROMPT,
    );
  });

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

    const parsed = JSON.parse(jsonStr);

    const verdict: 'safe' | 'unsafe' = parsed.verdict === 'safe' ? 'safe' : 'unsafe';
    const summary = typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided';
    const risks = Array.isArray(parsed.risks)
      ? parsed.risks.map((r: any) => ({
          level: ['low', 'medium', 'high'].includes(r.level) ? r.level : 'medium',
          description: typeof r.description === 'string' ? r.description : 'Unknown risk',
        }))
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
