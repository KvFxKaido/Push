/**
 * Planner Agent — lightweight pre-pass that decomposes large tasks into
 * a structured JSON feature checklist before delegating to the Coder.
 *
 * Inspired by Anthropic's harness design research: decomposing work into
 * tractable chunks prevents the "one-shot the entire app" failure mode
 * where the Coder runs out of context mid-implementation.
 *
 * The planner produces a PlannerFeatureList that the Coder works through
 * incrementally. Each feature becomes a verifiable unit of work.
 *
 * Design: fail-open. If the Planner fails, delegation proceeds without
 * a plan — the Coder's own internal planning takes over.
 */

import type { ChatMessage } from '@/types';
import {
  getActiveProvider,
  isProviderAvailable,
  getProviderStreamFn,
  type ActiveProvider,
} from './orchestrator';
import { resolveProviderSpecificModel } from './provider-selection';
import { getModelForRole } from './providers';
import { asRecord, streamWithTimeout } from './utils';

const PLANNER_TIMEOUT_MS = 45_000; // 45s — planner should be fast

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single feature/step in the planner's output. */
export interface PlannerFeature {
  /** Short identifier, e.g. "auth-form". */
  id: string;
  /** What to implement. */
  description: string;
  /** Files likely to be created or modified. */
  files?: string[];
  /** Shell command to verify completion (optional). */
  verifyCommand?: string;
  /** Dependencies on other feature IDs (ordering hint). */
  dependsOn?: string[];
}

/** The planner's structured output. */
export interface PlannerFeatureList {
  /** High-level approach summary. */
  approach: string;
  /** Ordered list of features/steps. */
  features: PlannerFeature[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM_PROMPT = `You are the Planner agent for Push, a mobile AI coding assistant. Your job is to decompose a coding task into an ordered list of discrete, implementable features.

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

export interface PlannerOptions {
  providerOverride?: ActiveProvider;
  modelOverride?: string | null;
}

/**
 * Run the planner pre-pass to decompose a task into features.
 * Returns null on any failure (fail-open — Coder proceeds without a plan).
 */
export async function runPlanner(
  task: string,
  files: string[],
  onStatus: (phase: string) => void,
  options?: PlannerOptions,
): Promise<PlannerFeatureList | null> {
  const requestedProvider =
    options?.providerOverride && isProviderAvailable(options.providerOverride)
      ? options.providerOverride
      : null;
  const activeProvider = requestedProvider || getActiveProvider();
  if (activeProvider === 'demo') return null;

  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'coder'); // Planner uses the same model slot as Coder
  const modelId =
    resolveProviderSpecificModel(
      activeProvider,
      options?.modelOverride,
      options?.providerOverride,
    ) || roleModel?.id;

  onStatus('Planning task...');

  const fileContext =
    files.length > 0 ? `\n\nRelevant files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';

  const messages: ChatMessage[] = [
    {
      id: 'planner-task',
      role: 'user',
      content: `Decompose this coding task into implementable features:\n\n${task}${fileContext}`,
      timestamp: Date.now(),
    },
  ];

  const { promise: streamErrorPromise, getAccumulated } = streamWithTimeout(
    PLANNER_TIMEOUT_MS,
    `Planner timed out after ${PLANNER_TIMEOUT_MS / 1000}s.`,
    (onToken, onDone, onError) => {
      return streamFn(
        messages,
        onToken,
        onDone,
        onError,
        undefined,
        undefined,
        false,
        modelId,
        PLANNER_SYSTEM_PROMPT,
      );
    },
  );
  const streamError = await streamErrorPromise;
  const accumulated = getAccumulated();

  if (streamError) {
    // Fail-open: log and return null
    console.warn('[Planner] Stream error:', streamError.message);
    return null;
  }

  // Parse JSON response
  try {
    let jsonStr = accumulated.trim();
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

/**
 * Format a PlannerFeatureList into a text block for injection into the
 * Coder's task preamble.
 */
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
