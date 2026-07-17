/**
 * Surface-neutral Coder policy.
 *
 * The policy owns deterministic state and emits primitive content plus the
 * shared steer/block intervention contract. Web/CLI adapters own message
 * records, logs, and presentation.
 */

import { detectTrailingActionIntent, responseClaimsCompletion } from './action-intent.js';
import {
  createBlockIntervention,
  createSteerIntervention,
  type RuntimeIntervention,
} from './runtime-intervention.js';
import {
  ANNOUNCED_NO_ACTION_POLICY_MARKER,
  MAX_TRAILING_INTENT_NUDGES,
} from './tool-call-recovery.js';

export interface CoderPolicyContext {
  round: number;
  maxRounds: number;
  phase?: string;
  allowedRepo?: string;
  taskInFlight?: boolean;
  /**
   * Delegated Coders preserve the original strict short-response guard.
   * Conversational lead hosts use claims_only so ordinary direct answers are
   * not mistaken for fake completion; explicit completion claims are still
   * grounded.
   */
  completionGuard?: 'strict' | 'claims_only';
}

export type CoderPolicyReason =
  | 'verification_phase_mutation'
  | 'cognitive_drift'
  | 'cognitive_drift_exhausted'
  | 'incomplete_completion'
  | 'announced_no_action'
  | 'mutation_hard_failure'
  | 'verification_backpressure';

export interface CoderPolicyInterventionContext {
  round: number;
  phase?: string;
  toolName?: string;
  target?: string;
  count?: number;
}

interface CoderPolicyDecisionBase {
  code: CoderPolicyReason;
  runtimeIntervention: RuntimeIntervention<CoderPolicyInterventionContext>;
}

export type CoderPolicyBeforeToolResult =
  | (CoderPolicyDecisionBase & { action: 'deny'; reason: string })
  | null;

export type CoderPolicyAfterResult =
  | (CoderPolicyDecisionBase & { action: 'inject'; content: string })
  | (CoderPolicyDecisionBase & { action: 'halt'; summary: string })
  | null;

export interface CoderRuntimePolicy {
  evaluateBeforeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: CoderPolicyContext,
  ): Promise<CoderPolicyBeforeToolResult>;
  evaluateAfterTool(
    toolName: string,
    args: Record<string, unknown>,
    resultText: string,
    hasError: boolean,
    ctx: CoderPolicyContext,
  ): Promise<CoderPolicyAfterResult>;
  evaluateAfterModel(
    response: string,
    messages: readonly unknown[],
    ctx: CoderPolicyContext,
  ): Promise<CoderPolicyAfterResult>;
}

export interface CoderPolicyEvent {
  event: 'coder_trailing_intent_nudged' | 'coder_trailing_intent_cap_exhausted';
  round: number;
  allowedRepo?: string;
  nudgeCount?: number;
  maxNudges?: number;
}

export interface CreateCoderPolicyOptions {
  onEvent?: (event: CoderPolicyEvent) => void;
}

/**
 * Select completion grounding from turn intent, never from the host surface.
 * Task-shaped turns stay strict even when they run through a conversational
 * lead; only explicitly conversational turns use claim-only grounding.
 */
export function resolveCoderCompletionGuard(
  taskInFlight: boolean | undefined,
): NonNullable<CoderPolicyContext['completionGuard']> {
  return taskInFlight === false ? 'claims_only' : 'strict';
}

export function formatCoderPolicyEvent(event: CoderPolicyEvent, runtimeHost: string): string {
  return JSON.stringify({
    level: event.event.endsWith('exhausted') ? 'warn' : 'info',
    ...event,
    runtimeHost,
  });
}

interface MutationFailureEntry {
  tool: string;
  file: string;
  count: number;
}

const MAX_CONSECUTIVE_MUTATION_FAILURES = 3;
const MAX_CONSECUTIVE_DRIFT_ROUNDS = 2;
const DRIFT_NON_ASCII_RATIO_THRESHOLD = 0.3;

export const BACKPRESSURE_MUTATION_THRESHOLD = 4;

export const VERIFICATION_COMMAND_PATTERN =
  /\b(tsc|typecheck|type-check|npx tsc|pyright|mypy|eslint|biome|prettier.*--check|ruff check|npm test|npx vitest|pytest|cargo test|go test|npm run lint|npm run test|npm run typecheck|npm run build|pnpm test|pnpm run lint|pnpm run test|pnpm run typecheck(?::\w+)?|pnpm run build)\b/i;

const VERIFICATION_TOOLS = new Set([
  'sandbox_run_tests',
  'sandbox_check_types',
  'sandbox_verify_workspace',
]);

const MUTATION_TOOLS = new Set([
  'sandbox_write_file',
  'sandbox_edit_file',
  'sandbox_edit_range',
  'sandbox_apply_patchset',
  'sandbox_search_replace',
  'write_file',
  'edit_file',
  'undo_edit',
]);

const EXEC_TOOLS = new Set(['sandbox_exec', 'exec']);

export function isVerificationPhase(phase: string | undefined): boolean {
  if (!phase) return false;
  return /\b(verif|test|validat|check|typecheck|lint)/i.test(phase);
}

function hasCodeSignals(text: string): boolean {
  return (
    /\{\s*"tool"\s*:/.test(text) ||
    /```/.test(text) ||
    /\/workspace\//.test(text) ||
    /\.[tj]sx?\b|\.py\b|\.json\b/.test(text) ||
    /sandbox_|coder_checkpoint|coder_update_state/.test(text)
  );
}

export function detectCognitiveDrift(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 200) return null;

  const reasons: string[] = [];
  const repeatedPattern = trimmed.match(/(.{1,4})\1{9,}/);
  if (repeatedPattern) {
    reasons.push(
      `Repeated token pattern: "${repeatedPattern[1]}" ×${Math.floor(repeatedPattern[0].length / repeatedPattern[1].length)}`,
    );
  }

  const nonAsciiCount = (trimmed.match(/[^\u0020-\u007E]/g) || []).length;
  const ratio = nonAsciiCount / trimmed.length;
  if (ratio > DRIFT_NON_ASCII_RATIO_THRESHOLD && nonAsciiCount > 50 && !hasCodeSignals(trimmed)) {
    reasons.push(`Non-ASCII ratio ${(ratio * 100).toFixed(0)}% with no code references`);
  }
  if ((trimmed.length > 1500 || trimmed.split('\n').length > 20) && !hasCodeSignals(trimmed)) {
    reasons.push('Extended prose without tool calls or code references');
  }

  if (reasons.length >= 2) return reasons.join('; ');
  if (repeatedPattern && repeatedPattern[0].length / repeatedPattern[1].length >= 20) {
    return reasons[0];
  }
  return null;
}

function contextFor(
  ctx: CoderPolicyContext,
  extra: Omit<CoderPolicyInterventionContext, 'round' | 'phase'> = {},
): CoderPolicyInterventionContext {
  return { round: ctx.round, phase: ctx.phase, ...extra };
}

function inject(
  code: CoderPolicyReason,
  point: 'after_model' | 'after_tool',
  content: string,
  context: CoderPolicyInterventionContext,
): Exclude<CoderPolicyAfterResult, null> {
  return {
    action: 'inject',
    code,
    content,
    runtimeIntervention: createSteerIntervention({
      point,
      source: 'coder_policy',
      reason: code,
      message: content.split('\n')[1] ?? content,
      guidance: content,
      context,
    }),
  };
}

function halt(
  code: CoderPolicyReason,
  summary: string,
  context: CoderPolicyInterventionContext,
): Exclude<CoderPolicyAfterResult, null> {
  return {
    action: 'halt',
    code,
    summary,
    runtimeIntervention: createBlockIntervention({
      point: 'after_model',
      source: 'coder_policy',
      reason: code,
      message: summary,
      context,
    }),
  };
}

export function createCoderPolicy(options: CreateCoderPolicyOptions = {}): CoderRuntimePolicy {
  let consecutiveDriftRounds = 0;
  let trailingIntentNudges = 0;
  const mutationFailures = new Map<string, MutationFailureEntry>();
  let mutationsSinceVerification = 0;

  return {
    async evaluateBeforeTool(toolName, _args, ctx) {
      if (!isVerificationPhase(ctx.phase) || !MUTATION_TOOLS.has(toolName)) return null;
      const reason = `Phase "${ctx.phase}" is verification-only. File mutations (${toolName}) are blocked. Run tests, typecheck, or diffs instead.`;
      return {
        action: 'deny',
        code: 'verification_phase_mutation',
        reason,
        runtimeIntervention: createBlockIntervention({
          point: 'before_tool',
          source: 'coder_policy',
          reason: 'verification_phase_mutation',
          message: reason,
          context: contextFor(ctx, { toolName }),
        }),
      };
    },

    async evaluateAfterModel(response, _messages, ctx) {
      const hasToolCall = /\{\s*"tool"\s*:/.test(response);

      if (ctx.taskInFlight === false || hasToolCall) {
        consecutiveDriftRounds = 0;
      } else {
        const driftReason = detectCognitiveDrift(response);
        if (driftReason) {
          consecutiveDriftRounds += 1;
          if (consecutiveDriftRounds >= MAX_CONSECUTIVE_DRIFT_ROUNDS) {
            return halt(
              'cognitive_drift_exhausted',
              `[Coder stopped — cognitive drift detected for ${consecutiveDriftRounds} consecutive rounds. ${driftReason}. Task may be incomplete.]`,
              contextFor(ctx, { count: consecutiveDriftRounds }),
            );
          }
          return inject(
            'cognitive_drift',
            'after_model',
            [
              '[POLICY: DRIFT_DETECTED]',
              `You are generating unrelated content instead of working on the task. ${driftReason}.`,
              'Stop and re-evaluate. Re-read your task and working memory, then either use a tool or summarize your progress.',
              '[/POLICY]',
            ].join('\n'),
            contextFor(ctx, { count: consecutiveDriftRounds }),
          );
        }
        consecutiveDriftRounds = 0;
      }

      const trimmed = response.trim();
      if (trimmed && !hasToolCall && detectTrailingActionIntent(trimmed)) {
        if (trailingIntentNudges >= MAX_TRAILING_INTENT_NUDGES) {
          options.onEvent?.({
            event: 'coder_trailing_intent_cap_exhausted',
            round: ctx.round,
            allowedRepo: ctx.allowedRepo,
            maxNudges: MAX_TRAILING_INTENT_NUDGES,
          });
          return null;
        }

        trailingIntentNudges += 1;
        options.onEvent?.({
          event: 'coder_trailing_intent_nudged',
          round: ctx.round,
          allowedRepo: ctx.allowedRepo,
          nudgeCount: trailingIntentNudges,
        });
        return inject(
          'announced_no_action',
          'after_model',
          [
            ANNOUNCED_NO_ACTION_POLICY_MARKER,
            'You described an action you were about to take (e.g. reading or searching a file) but did not emit a tool call, so nothing actually happened.',
            'If you intended to act, emit the tool-call JSON now. If you are actually finished, state your conclusion directly without describing further steps.',
            '[/POLICY]',
          ].join('\n'),
          contextFor(ctx, { count: trailingIntentNudges }),
        );
      }

      if (
        ctx.taskInFlight !== false &&
        !hasToolCall &&
        !/coder_checkpoint/.test(trimmed) &&
        !/coder_update_state/.test(trimmed) &&
        (ctx.completionGuard !== 'claims_only' || responseClaimsCompletion(trimmed))
      ) {
        // Preserve the original web guard's deliberately strict task
        // semantics: any short terminal-looking response must carry concrete
        // evidence, not only responses that happen to match a completion-claim
        // phrase. Conversational turns opt out via taskInFlight above.
        const hasConcreteReference =
          /(?:\b(?:file|path|command|test suite|typecheck|lint)\b|(?:^|[\s`'"(])(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|json|css|md)\b|`[^`]+`)/i.test(
            trimmed,
          );
        const hasGroundedInvestigation =
          /\b(findings?|traced|investigated|reviewed|verified|validated|tested|inspected)\b/i.test(
            trimmed,
          ) && hasConcreteReference;
        const hasSuccessfulVerificationResult =
          VERIFICATION_COMMAND_PATTERN.test(trimmed) &&
          /\b(passed|passing|succeeded|successful|green|clean|no errors?)\b/i.test(trimmed);
        const hasGroundedRead =
          /\b(read|reading|inspected|reviewed)\b.*\b(file|path|\.[cm]?[jt]sx?|\.py|\.json|\.css|\.md)\b/i.test(
            trimmed,
          );
        const hasLeadSummaryEvidence =
          ctx.completionGuard === 'claims_only' &&
          /\b(findings?|traced|investigated|reviewed|verified|validated|tested|inspected|summarized)\b/i.test(
            trimmed,
          );
        const hasArtifactEvidence =
          /\b(modified|created|updated|deleted|wrote|edited|changed)\b.*\b(file|\.[tj]sx?|\.py|\.json|\.css)\b/i.test(
            trimmed,
          ) ||
          /sandbox_diff|sandbox_commit|prepare_push|git_diff|git_commit/.test(trimmed) ||
          /acceptance\s+criteria|\[Acceptance Criteria\]/i.test(trimmed) ||
          hasGroundedInvestigation ||
          hasSuccessfulVerificationResult ||
          hasLeadSummaryEvidence ||
          hasGroundedRead;
        const hasBlockedReport =
          /\b(blocked|cannot|unable|impossible|not possible|stuck)\b/i.test(trimmed) &&
          trimmed.length > 50;

        if (!hasArtifactEvidence && !hasBlockedReport && trimmed.length < 200) {
          return inject(
            'incomplete_completion',
            'after_model',
            [
              '[POLICY: INCOMPLETE_COMPLETION]',
              'Your response claims completion but has no evidence of changed files, diff output, or acceptance criteria results.',
              'Either:',
              '1. Use a tool to verify your changes',
              '2. Summarize exactly which files were changed and how',
              '3. Report what is blocking you with specifics',
              '[/POLICY]',
            ].join('\n'),
            contextFor(ctx),
          );
        }
      }

      return null;
    },

    async evaluateAfterTool(toolName, args, _resultText, hasError, ctx) {
      if (!hasError) {
        if (VERIFICATION_TOOLS.has(toolName)) mutationsSinceVerification = 0;
        if (
          EXEC_TOOLS.has(toolName) &&
          typeof args.command === 'string' &&
          VERIFICATION_COMMAND_PATTERN.test(args.command)
        ) {
          mutationsSinceVerification = 0;
        }
      }

      const filePath =
        (typeof args.path === 'string' ? args.path : '') ||
        (typeof args.file === 'string' ? args.file : '');
      const mutationKey = `${toolName}::${filePath}`;

      if (MUTATION_TOOLS.has(toolName) || hasError) {
        if (!hasError) {
          mutationFailures.delete(mutationKey);
        } else {
          const existing = mutationFailures.get(mutationKey);
          if (existing) existing.count += 1;
          else mutationFailures.set(mutationKey, { tool: toolName, file: filePath, count: 1 });

          const entry = mutationFailures.get(mutationKey)!;
          if (entry.count >= MAX_CONSECUTIVE_MUTATION_FAILURES) {
            return inject(
              'mutation_hard_failure',
              'after_tool',
              [
                '[POLICY: MUTATION_HARD_FAILURE]',
                `${entry.tool} has failed ${entry.count} consecutive times on ${entry.file || 'the same target'}.`,
                'Container may be unstable. Stop mutation attempts. Summarize what you accomplished and what remains.',
                '[/POLICY]',
              ].join('\n'),
              contextFor(ctx, { toolName, target: entry.file, count: entry.count }),
            );
          }
        }
      }

      if (MUTATION_TOOLS.has(toolName) && !hasError) {
        mutationsSinceVerification += 1;
        if (mutationsSinceVerification >= BACKPRESSURE_MUTATION_THRESHOLD) {
          return inject(
            'verification_backpressure',
            'after_tool',
            [
              '[POLICY: VERIFY_BEFORE_CONTINUING]',
              `You have made ${mutationsSinceVerification} file mutations without running verification.`,
              'Before writing more code, run at least one typecheck, lint, or test command.',
              'This catches errors early and prevents compounding mistakes across files.',
              '[/POLICY]',
            ].join('\n'),
            contextFor(ctx, { toolName, target: filePath, count: mutationsSinceVerification }),
          );
        }
      }

      return null;
    },
  };
}
