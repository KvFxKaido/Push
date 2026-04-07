/**
 * Coder Turn Policy — drift detection, mutation failure tracking,
 * and no-fake-completion guard.
 *
 * Consolidates:
 * - Cognitive drift detection (was: detectCognitiveDrift in coder-agent.ts)
 * - Mutation failure tracking (was: inline Map in coder-agent.ts loop)
 * - No-fake-completion guard (new: inspired by Open SWE's ensure_no_empty_msg)
 *
 * The Coder must end each run with changed files, a blocked report, or
 * explicit acceptance-criteria results. Claiming "done" with nothing to
 * show triggers a correction.
 */

import type { ChatMessage } from '@/types';
import type { TurnPolicy, TurnContext } from '../turn-policy';
import { isVerificationPhase } from '../turn-policy';

// ---------------------------------------------------------------------------
// Drift detection (extracted from coder-agent.ts)
// ---------------------------------------------------------------------------

const DRIFT_NON_ASCII_RATIO_THRESHOLD = 0.3;

function hasCodeSignals(text: string): boolean {
  return /\{\s*"tool"\s*:/.test(text)
    || /```/.test(text)
    || /\/workspace\//.test(text)
    || /\.[tj]sx?\b|\.py\b|\.json\b/.test(text)
    || /sandbox_|coder_checkpoint|coder_update_state/.test(text);
}

/**
 * Detect cognitive drift — multiple converging signals required.
 * Returns a reason string if drift is detected, null otherwise.
 */
export function detectCognitiveDrift(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 200) return null;

  const reasons: string[] = [];

  // Signal A: Repeated token patterns (1-4 chars repeated 10+ times)
  const repeatedPattern = trimmed.match(/(.{1,4})\1{9,}/);
  if (repeatedPattern) {
    reasons.push(
      `Repeated token pattern: "${repeatedPattern[1]}" ×${Math.floor(repeatedPattern[0].length / repeatedPattern[1].length)}`,
    );
  }

  // Signal B: High non-ASCII ratio with no code references
  const nonAsciiCount = (trimmed.match(/[^\u0020-\u007E]/g) || []).length;
  const ratio = nonAsciiCount / trimmed.length;
  if (ratio > DRIFT_NON_ASCII_RATIO_THRESHOLD && nonAsciiCount > 50 && !hasCodeSignals(trimmed)) {
    reasons.push(`Non-ASCII ratio ${(ratio * 100).toFixed(0)}% with no code references`);
  }

  // Signal C: Extended prose with no tool calls or code
  if (trimmed.length > 1500 || trimmed.split('\n').length > 20) {
    if (!hasCodeSignals(trimmed)) {
      reasons.push('Extended prose without tool calls or code references');
    }
  }

  // Require 2+ signals, or 20+ token repeats alone
  if (reasons.length >= 2) return reasons.join('; ');
  if (repeatedPattern && repeatedPattern[0].length / repeatedPattern[1].length >= 20) {
    return reasons[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stateful trackers (scoped per policy instance)
// ---------------------------------------------------------------------------

interface MutationFailureEntry {
  tool: string;
  file: string;
  errorType: string;
  count: number;
}

const MAX_CONSECUTIVE_MUTATION_FAILURES = 3;
const MAX_CONSECUTIVE_DRIFT_ROUNDS = 2;

/**
 * Mechanical backpressure: after this many successful file mutations without
 * a verification command (typecheck, test, lint), inject a policy nudge
 * requiring the Coder to validate its work before continuing.
 *
 * Inspired by the Ralph Loop pattern (ghuntley.com/ralph) and OpenAI's
 * harness engineering practice of using automated rejection signals.
 */
export const BACKPRESSURE_MUTATION_THRESHOLD = 4;

/**
 * Patterns that indicate a sandbox_exec command is a verification command.
 * When detected, the mutation-without-verification counter resets.
 *
 * NOTE: This is a fallback for freeform sandbox_exec commands. The canonical
 * verification tools (sandbox_run_tests, sandbox_check_types) are handled
 * separately via SANDBOX_VERIFICATION_TOOLS. Session-level verification
 * policy commands (from extractCommandRules()) map to these same patterns
 * in practice; if custom commands diverge, pass the verification policy
 * into createCoderPolicy() in a future iteration.
 */
export const VERIFICATION_COMMAND_PATTERN =
  /\b(tsc|typecheck|type-check|npx tsc|pyright|mypy|eslint|biome|prettier.*--check|ruff check|npm test|npx vitest|pytest|cargo test|go test|npm run lint|npm run test|npm run typecheck|npm run build)\b/i;

/**
 * Built-in sandbox tools that perform verification.
 * These reset the backpressure mutation counter when invoked.
 */
const SANDBOX_VERIFICATION_TOOLS = new Set([
  'sandbox_run_tests',
  'sandbox_check_types',
  'sandbox_verify_workspace',
]);

/**
 * Sandbox tools that mutate files. During verification phases, these are
 * blocked to enforce a read-only + run-tests discipline.
 * sandbox_exec is intentionally excluded — tests/typecheck need to run.
 */
const SANDBOX_MUTATION_TOOLS = new Set([
  'sandbox_write_file',
  'sandbox_edit_file',
  'sandbox_edit_range',
  'sandbox_apply_patchset',
  'sandbox_search_replace',
]);

/**
 * Create a Coder turn policy with its own mutable tracking state.
 * Each Coder delegation gets a fresh policy instance via createCoderPolicy().
 */
export function createCoderPolicy(): TurnPolicy {
  // --- Per-instance mutable state ---
  let consecutiveDriftRounds = 0;
  const mutationFailures = new Map<string, MutationFailureEntry>();
  let mutationsSinceVerification = 0;

  return {
    name: 'coder-core',
    role: 'coder',

    // -----------------------------------------------------------------
    // beforeToolExec: phase-aware mutation gating
    // -----------------------------------------------------------------
    beforeToolExec: [
      (toolName: string, _args: Record<string, unknown>, ctx: TurnContext) => {
        if (!isVerificationPhase(ctx.phase)) return null;
        if (!SANDBOX_MUTATION_TOOLS.has(toolName)) return null;
        return {
          action: 'deny' as const,
          reason: `Phase "${ctx.phase}" is verification-only. File mutations (${toolName}) are blocked. Run tests, typecheck, or diffs instead.`,
        };
      },
    ],

    // -----------------------------------------------------------------
    // afterModelCall: drift detection + no-fake-completion
    // -----------------------------------------------------------------
    afterModelCall: [
      // Drift detection
      (response: string, _messages: readonly ChatMessage[], ctx: TurnContext) => {
        // Only check responses that don't contain tool calls
        if (/\{\s*"tool"\s*:/.test(response)) {
          consecutiveDriftRounds = 0;
          return null;
        }

        const driftReason = detectCognitiveDrift(response);
        if (!driftReason) {
          consecutiveDriftRounds = 0;
          return null;
        }

        consecutiveDriftRounds++;

        if (consecutiveDriftRounds >= MAX_CONSECUTIVE_DRIFT_ROUNDS) {
          return {
            action: 'halt' as const,
            summary: `[Coder stopped — cognitive drift detected for ${consecutiveDriftRounds} consecutive rounds. ${driftReason}. Task may be incomplete.]`,
          };
        }

        // First drift — inject correction
        return {
          action: 'inject' as const,
          message: {
            id: `policy-drift-correction-${ctx.round}`,
            role: 'user' as const,
            content: [
              '[POLICY: DRIFT_DETECTED]',
              `You are generating unrelated content instead of working on the task. ${driftReason}.`,
              'Stop and re-evaluate. Re-read your task and working memory, then either use a tool or summarize your progress.',
              '[/POLICY]',
            ].join('\n'),
            timestamp: Date.now(),
          },
        };
      },

      // No-fake-completion guard
      (response: string, _messages: readonly ChatMessage[], ctx: TurnContext) => {
        const trimmed = response.trim();

        // Has a tool call → not a completion attempt
        if (/\{\s*"tool"\s*:/.test(trimmed)) return null;
        // Has a checkpoint → handled separately
        if (/coder_checkpoint/.test(trimmed)) return null;
        // Has a state update → handled separately
        if (/coder_update_state/.test(trimmed)) return null;

        // Check for terminal artifacts that indicate real completion:
        // - References to changed files / diffs
        // - Acceptance criteria results
        // - Explicit "blocked" / "cannot" language
        const hasArtifactEvidence =
          /\b(modified|created|updated|deleted|wrote|edited|changed)\b.*\b(file|\.ts|\.js|\.py|\.json|\.css)\b/i.test(trimmed)
          || /sandbox_diff|sandbox_prepare_commit/.test(trimmed)
          || /acceptance\s+criteria/i.test(trimmed)
          || /\[Acceptance Criteria\]/i.test(trimmed);

        const hasBlockedReport =
          /\b(blocked|cannot|unable|impossible|not possible|stuck)\b/i.test(trimmed)
          && trimmed.length > 50;

        if (hasArtifactEvidence || hasBlockedReport) return null;

        // Short vague completion with no evidence → nudge
        if (trimmed.length < 200) {
          return {
            action: 'inject' as const,
            message: {
              id: `policy-no-fake-completion-${ctx.round}`,
              role: 'user' as const,
              content: [
                '[POLICY: INCOMPLETE_COMPLETION]',
                'Your response claims completion but has no evidence of changed files, diff output, or acceptance criteria results.',
                'Either:',
                '1. Use a tool to verify your changes (sandbox_diff, sandbox_read_file)',
                '2. Summarize exactly which files were changed and how',
                '3. Report what is blocking you with specifics',
                '[/POLICY]',
              ].join('\n'),
              timestamp: Date.now(),
            },
          };
        }

        return null;
      },
    ],

    // -----------------------------------------------------------------
    // afterToolExec: unified mutation tracking + mechanical backpressure
    //
    // Single hook so failure-state cleanup always runs even when
    // backpressure injects. evaluateAfterTool() short-circuits on the
    // first non-null return, so separate hooks would skip cleanup.
    // -----------------------------------------------------------------
    afterToolExec: [
      (
        toolName: string,
        args: Record<string, unknown>,
        _resultText: string,
        hasError: boolean,
        ctx: TurnContext,
      ) => {
        // --- Backpressure: reset counter on *successful* verification tools ---
        // Only reset when the verification actually passed; a broken `npm test`
        // or typoed `npx tsc` should not grant a clean mutation slate.
        if (!hasError) {
          // Built-in verification tools
          if (SANDBOX_VERIFICATION_TOOLS.has(toolName)) {
            mutationsSinceVerification = 0;
          }
          // sandbox_exec with a verification command
          if (toolName === 'sandbox_exec' && typeof args.command === 'string') {
            if (VERIFICATION_COMMAND_PATTERN.test(args.command)) {
              mutationsSinceVerification = 0;
            }
          }
        }

        // --- Mutation failure tracking (always runs) ---
        const filePath =
          (typeof args.path === 'string' ? args.path : '') ||
          (typeof args.file === 'string' ? args.file : '');
        const mutKey = `${toolName}::${filePath}`;

        if (SANDBOX_MUTATION_TOOLS.has(toolName) || hasError) {
          if (!hasError) {
            // Success — clear failure tracking for this tool+file
            mutationFailures.delete(mutKey);
          } else {
            // Track failure
            const existing = mutationFailures.get(mutKey);
            if (existing) {
              existing.count++;
            } else {
              mutationFailures.set(mutKey, {
                tool: toolName,
                file: filePath,
                errorType: 'structured_error',
                count: 1,
              });
            }

            const entry = mutationFailures.get(mutKey)!;
            if (entry.count >= MAX_CONSECUTIVE_MUTATION_FAILURES) {
              return {
                action: 'inject' as const,
                message: {
                  id: `policy-mutation-hard-failure-${ctx.round}`,
                  role: 'user' as const,
                  content: [
                    '[POLICY: MUTATION_HARD_FAILURE]',
                    `${entry.tool} has failed ${entry.count} consecutive times on ${entry.file || 'the same target'}.`,
                    'Container may be unstable. Stop mutation attempts. Summarize what you accomplished and what remains.',
                    '[/POLICY]',
                  ].join('\n'),
                  timestamp: Date.now(),
                },
              };
            }
          }
        }

        // --- Backpressure: count mutations and nudge ---
        if (SANDBOX_MUTATION_TOOLS.has(toolName) && !hasError) {
          mutationsSinceVerification++;

          if (mutationsSinceVerification >= BACKPRESSURE_MUTATION_THRESHOLD) {
            const count = mutationsSinceVerification;
            return {
              action: 'inject' as const,
              message: {
                id: `policy-backpressure-${ctx.round}`,
                role: 'user' as const,
                content: [
                  '[POLICY: VERIFY_BEFORE_CONTINUING]',
                  `You have made ${count} file mutations without running verification.`,
                  'Before writing more code, run at least one of: typecheck (e.g. npx tsc --noEmit), lint (e.g. npx eslint), or tests (e.g. npm test).',
                  'This catches errors early and prevents compounding mistakes across files.',
                  'Use sandbox_exec, sandbox_run_tests, or sandbox_check_types to verify.',
                  '[/POLICY]',
                ].join('\n'),
                timestamp: Date.now(),
              },
            };
          }
        }

        return null;
      },
    ],
  };
}
