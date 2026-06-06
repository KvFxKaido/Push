/**
 * Planner core — pure task-decomposition logic with an injectable streaming
 * primitive. Both web (`app/src/lib/planner-agent.ts`) and CLI
 * (`cli/delegation-entry.ts`) wrap this with their own provider abstraction.
 *
 * Fail-open: any failure path returns `null` so callers can proceed without
 * a plan. The Coder's own internal planning takes over in that case.
 */

import type { AIProviderType, LlmMessage, PushStream } from './provider-contract.js';
import { iteratePushStreamText } from './stream-utils.js';
import { formatUserGoalBlock, type UserGoalAnchor } from './user-goal-anchor.ts';
import { z } from 'zod';
import { parseStructured } from './structured-output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerFeature {
  id: string;
  description: string;
  files?: string[];
  verifyCommand?: string;
  dependsOn?: string[];
  /**
   * Short rationale tying this feature back to the user's goal. Mirrors
   * `TaskGraphNode.addresses`. Populated by the planner when a user goal
   * is provided via `PlannerCoreOptions.goal`; flows downstream into the
   * generated `TaskGraphNode.addresses` for runtime validation by
   * `validateTaskGraphAgainstGoal`.
   */
  addresses?: string;
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
  /**
   * Optional user-goal anchor. When provided, the planner sees the
   * formatted `[USER_GOAL]` block in the user-task message and is asked
   * to populate `addresses` on every feature naming which part of the
   * goal it advances. The downstream `validateTaskGraphAgainstGoal`
   * check in `cli/delegation-entry.ts` then enforces that the conversion
   * produced nodes with `addresses` populated; on miss, the CLI falls
   * back to the non-delegated loop (one-shot fail-open contract — see
   * docs/decisions/Goal-Anchored Task Graph Layering.md).
   */
  goal?: UserGoalAnchor;
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
      "dependsOn": ["other-feature-id"],
      "addresses": "short rationale tying this feature to the user goal — required when a [USER_GOAL] block appears in the task context, omit otherwise"
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
- 'addresses' is required on every feature whenever the task context includes a [USER_GOAL] block. The string should reference one section of the goal — "Initial ask", "Current working goal" (when present), or a specific named Constraint — and briefly say how the feature advances that section. Omit the field when no goal block is present.
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
    goal,
  } = options;

  onStatus?.('Planning task...');

  const fileContext =
    files.length > 0 ? `\n\nRelevant files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';

  // Surface the user-goal anchor at the *start* of the message so the
  // planner reads it before the task description. Same shape the
  // orchestrator's `[USER_GOAL]` injection uses, so the model encounters
  // identical vocabulary across surfaces.
  const goalContext = goal ? `${formatUserGoalBlock(goal)}\n\n` : '';

  const messages: LlmMessage[] = [
    {
      id: 'planner-task',
      role: 'user',
      content: `${goalContext}Decompose this coding task into implementable features:\n\n${task}${fileContext}`,
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

// ---------------------------------------------------------------------------
// Response schema — single source of truth for the JSON the Planner prompt
// asks the model to emit. The per-feature object requires `id` + `description`
// (a feature missing either is dropped, not fatal); the optional fields are
// shaped in a transform that omits absent keys and filters non-string array
// members, exactly as the old hand-rolled mapping did.
// ---------------------------------------------------------------------------

const PlannerFeatureSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    // Typed as optional unknown so an absent or malformed optional field never
    // fails the feature; the transform below applies the same coercion the old
    // hand-rolled mapping did.
    files: z.unknown().optional(),
    verifyCommand: z.unknown().optional(),
    dependsOn: z.unknown().optional(),
    addresses: z.unknown().optional(),
  })
  .transform((f): PlannerFeature => {
    const feature: PlannerFeature = { id: f.id, description: f.description };
    if (Array.isArray(f.files)) {
      feature.files = f.files.filter((v): v is string => typeof v === 'string');
    }
    if (typeof f.verifyCommand === 'string') {
      feature.verifyCommand = f.verifyCommand;
    }
    if (Array.isArray(f.dependsOn)) {
      feature.dependsOn = f.dependsOn.filter((v): v is string => typeof v === 'string');
    }
    if (typeof f.addresses === 'string' && f.addresses.trim()) {
      feature.addresses = f.addresses.trim();
    }
    return feature;
  });

const PlannerFeatureListSchema = z.object({
  approach: z.string().catch(''),
  // Drop any element that isn't a valid feature (missing id/description),
  // mirroring the old `.map(...).filter(f => f !== null)`.
  features: z
    .array(z.unknown())
    .catch([])
    .transform((arr) =>
      arr.flatMap((f) => {
        const r = PlannerFeatureSchema.safeParse(f);
        return r.success ? [r.data] : [];
      }),
    ),
});

export function parsePlannerResponse(raw: string): PlannerFeatureList | null {
  const parseResult = parseStructured(raw, PlannerFeatureListSchema);
  if (!parseResult.ok) {
    // Fail-open: callers proceed without a plan. Log the branch so a
    // persistent planner-format regression is visible to ops rather than
    // silently degrading to the Coder's internal planning.
    console.log(
      JSON.stringify({ level: 'warn', event: 'planner_parse_failed', reason: parseResult.reason }),
    );
    return null;
  }

  const plan = parseResult.data;
  if (plan.features.length === 0) {
    // Parsed cleanly but produced no usable features — a distinct, formerly
    // silent fail-open path that callers can't tell from a parse error.
    console.log(JSON.stringify({ level: 'warn', event: 'planner_no_features' }));
    return null;
  }

  return plan;
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
