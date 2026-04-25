/**
 * Planner core — pure task-decomposition logic with an injectable streaming
 * primitive. Both web (`app/src/lib/planner-agent.ts`) and CLI
 * (`cli/delegation-entry.ts`) wrap this with their own provider abstraction.
 *
 * Fail-open: any failure path returns `null` so callers can proceed without
 * a plan. The Coder's own internal planning takes over in that case.
 */

import type { AIProviderType, LlmMessage, PushStream } from './provider-contract.js';
import { asRecord, iteratePushStreamText } from './stream-utils.js';

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

export interface PlannerCoreOptions {
  task: string;
  files: string[];
  /**
   * PushStream the Planner iterates directly. Phase 6 of the PushStream
   * gateway migration moved the Planner off its custom `PlannerStreamFn`
   * adapter shape — callers now pass either a native PushStream or a legacy
   * `ProviderStreamFn` wrapped with `providerStreamFnToPushStream`.
   */
  stream: PushStream<LlmMessage>;
  /**
   * Provider tag forwarded into the PushStream request. The core only uses
   * this to assemble the request envelope; routing decisions belong to the
   * caller.
   */
  provider: AIProviderType;
  modelId?: string | null;
  onStatus?: (phase: string) => void;
  /** Activity-based timeout (resets on each event). Defaults to 45s. */
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
      "description": "What to investigate and then implement in this step. Start with the reads/searches the coder must perform before producing any output.",
      "files": ["path/to/existing/source.ts"],
      "verifyCommand": "optional shell command that verifies real work (e.g. 'npm test -- --filter auth', 'npm run typecheck'). Never 'test -f' for a file the plan will create.",
      "dependsOn": ["other-feature-id"]
    }
  ]
}

Guidelines:
- The 'files' array is an INPUT list — existing source files the coder MUST READ to ground the implementation. It is never an output list. For a "document X" or "explain X" task, list the source files X is implemented in, not the documentation file the coder might produce.
- Do not invent output paths. If a feature produces a new file, describe that in the 'description' prose; do not list the new path in 'files', and do not fabricate a 'verifyCommand' that checks for its existence.
- Each feature's 'description' should begin with investigation (what to read, what to search) before any generation. Investigation-first is the default posture.
- Each feature should be completable in 3-8 Coder rounds (not too large, not too trivial).
- Order features so dependencies come first. Use 'dependsOn' to make ordering explicit.
- Include 'verifyCommand' only when a natural existing check applies (a test filter, a typecheck, a lint command). Do not fabricate verify commands that depend on files the plan will create.
- Keep the total number of features reasonable (2-8 for most tasks). If the task is already small/focused enough for a single feature, return exactly one feature.
- File paths should use the /workspace/ prefix convention when the Coder runs in a sandbox; otherwise use workspace-relative paths that the Coder's tools will accept.
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
    stream,
    provider,
    modelId = null,
    onStatus,
    timeoutMs = PLANNER_TIMEOUT_MS,
  } = options;

  onStatus?.('Planning task...');

  const fileContext =
    files.length > 0 ? `\n\nRelevant files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';

  const messages: LlmMessage[] = [
    {
      id: 'planner-task',
      role: 'user',
      content: `Decompose this coding task into implementable features:\n\n${task}${fileContext}`,
      timestamp: Date.now(),
    },
  ];

  const { error: streamError, text: accumulated } = await iteratePushStreamText(
    stream,
    {
      provider,
      model: modelId ?? '',
      messages,
      systemPromptOverride: PLANNER_SYSTEM_PROMPT,
      hasSandbox: false,
    },
    timeoutMs,
    `Planner timed out after ${Math.round(timeoutMs / 1000)}s.`,
  );

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
