/**
 * Planner core — pure task-decomposition logic with an injectable streaming
 * primitive. Both web (`app/src/lib/planner-agent.ts`) and CLI
 * (`cli/delegation-entry.ts`) wrap this with their own provider abstraction.
 *
 * Fail-open: any failure path returns `null` so callers can proceed without
 * a plan. The Coder's own internal planning takes over in that case.
 */

import { asRecord, streamWithTimeout } from './stream-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerFeature {
  id: string;
  description: string;
  files?: string[];
  verifyCommand?: string;
  dependsOn?: string[];
}

export interface PlannerFeatureList {
  approach: string;
  features: PlannerFeature[];
}

export interface PlannerMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The streaming primitive the core depends on. Callers wrap their
 * provider-specific stream function to match this shape.
 */
export type PlannerStreamFn = (
  messages: PlannerMessage[],
  systemPrompt: string,
  modelId: string | null,
  callbacks: {
    onToken: (token: string) => void;
    onDone: () => void;
    onError: (err: Error) => void;
  },
) => void | Promise<void>;

export interface PlannerCoreOptions {
  task: string;
  files: string[];
  streamFn: PlannerStreamFn;
  modelId?: string | null;
  onStatus?: (phase: string) => void;
  /** Activity-based timeout (resets on each token). Defaults to 45s. */
  timeoutMs?: number;
}

export const PLANNER_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT = `You are the Planner agent for Push, a mobile AI coding assistant. Your job is to decompose a coding task into an ordered list of discrete, implementable features.

You MUST respond with ONLY a valid JSON object. No other text.

Schema:
{
  "approach": "1-2 sentence summary of overall implementation approach",
  "features": [
    {
      "id": "short-kebab-case-id",
      "description": "What to implement in this step",
      "files": ["path/to/file.ts"],
      "verifyCommand": "optional shell command to verify (e.g. 'npm test -- --filter auth')",
      "dependsOn": ["other-feature-id"]
    }
  ]
}

Guidelines:
- Each feature should be completable in 3-8 Coder rounds (not too large, not too trivial).
- Order features so dependencies come first. Use dependsOn to make ordering explicit.
- Include verify commands when there's a natural way to check completion (tests, type checks, build).
- Keep the total number of features reasonable (2-8 for most tasks).
- If the task is already small/focused enough for a single feature, return exactly one feature.
- File paths should use the /workspace/ prefix convention.
- Focus on the implementation plan, not on explaining the task back.`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runPlannerCore(
  options: PlannerCoreOptions,
): Promise<PlannerFeatureList | null> {
  const {
    task,
    files,
    streamFn,
    modelId = null,
    onStatus,
    timeoutMs = PLANNER_TIMEOUT_MS,
  } = options;

  onStatus?.('Planning task...');

  const fileContext =
    files.length > 0 ? `\n\nRelevant files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';

  const messages: PlannerMessage[] = [
    {
      role: 'user',
      content: `Decompose this coding task into implementable features:\n\n${task}${fileContext}`,
    },
  ];

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    timeoutMs,
    `Planner timed out after ${Math.round(timeoutMs / 1000)}s.`,
    (onToken, onDone, onError) =>
      streamFn(messages, PLANNER_SYSTEM_PROMPT, modelId, { onToken, onDone, onError }),
  );

  const streamError = await streamErrorPromise;
  const accumulated = getAccumulated();

  if (streamError) {
    console.warn('[Planner] Stream error:', streamError.message);
    return null;
  }

  return parsePlannerResponse(accumulated);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parsePlannerResponse(raw: string): PlannerFeatureList | null {
  try {
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = asRecord(JSON.parse(jsonStr));
    if (!parsed) return null;

    const approach = typeof parsed.approach === 'string' ? parsed.approach : '';
    const rawFeatures = Array.isArray(parsed.features) ? parsed.features : [];

    const features: PlannerFeature[] = rawFeatures
      .map((f) => {
        const feat = asRecord(f);
        if (!feat || typeof feat.id !== 'string' || typeof feat.description !== 'string')
          return null;
        const feature: PlannerFeature = {
          id: feat.id,
          description: feat.description,
        };
        if (Array.isArray(feat.files)) {
          feature.files = (feat.files as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          );
        }
        if (typeof feat.verifyCommand === 'string') {
          feature.verifyCommand = feat.verifyCommand;
        }
        if (Array.isArray(feat.dependsOn)) {
          feature.dependsOn = (feat.dependsOn as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          );
        }
        return feature;
      })
      .filter((f): f is PlannerFeature => f !== null);

    if (features.length === 0) return null;

    return { approach, features };
  } catch {
    console.warn('[Planner] Failed to parse response');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export function formatPlannerBrief(plan: PlannerFeatureList): string {
  const lines: string[] = [
    '[IMPLEMENTATION PLAN]',
    `Approach: ${plan.approach}`,
    '',
    'Features (implement in order):',
  ];

  for (let i = 0; i < plan.features.length; i++) {
    const f = plan.features[i];
    lines.push(`${i + 1}. [${f.id}] ${f.description}`);
    if (f.files?.length) lines.push(`   Files: ${f.files.join(', ')}`);
    if (f.verifyCommand) lines.push(`   Verify: ${f.verifyCommand}`);
    if (f.dependsOn?.length) lines.push(`   Depends on: ${f.dependsOn.join(', ')}`);
  }

  lines.push('');
  lines.push(
    'Work through features sequentially. Update your working memory (currentPhase, completedPhases) as you complete each one.',
  );
  lines.push('[/IMPLEMENTATION PLAN]');

  return lines.join('\n');
}
