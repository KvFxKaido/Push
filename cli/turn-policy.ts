/**
 * Turn Policy for CLI — phase-aware agent guardrails.
 *
 * Lightweight port of the web app's turn-policy system (app/src/lib/turn-policy.ts)
 * adapted for the CLI's simpler agent loop. Shares the same concepts:
 *   - TurnContext with phase tracking
 *   - beforeToolExec gating (phase-aware mutation blocking)
 *   - afterModelCall guards (drift detection, no-fake-completion)
 *
 * This is intentionally a standalone file (no cross-package imports) to keep
 * the CLI self-contained while sharing the same policy contract.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TurnContext {
  role: 'coder';
  round: number;
  maxRounds: number;
  phase?: string;
}

export type BeforeToolResult = { action: 'deny'; reason: string } | null;

export type AfterModelResult =
  | { action: 'inject'; message: string }
  | { action: 'halt'; summary: string }
  | null;

type BeforeToolHook = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: TurnContext,
) => BeforeToolResult;

type AfterModelHook = (response: string, ctx: TurnContext) => AfterModelResult;

export interface TurnPolicy {
  name: string;
  beforeToolExec?: BeforeToolHook[];
  afterModelCall?: AfterModelHook[];
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

export function isVerificationPhase(phase: string | undefined): boolean {
  if (!phase) return false;
  return /\b(verif|test|validat|check|typecheck|lint)/i.test(phase);
}

// ---------------------------------------------------------------------------
// Mutation tools — file-mutating tools that should be blocked during verification
// ---------------------------------------------------------------------------

const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'undo_edit']);

// ---------------------------------------------------------------------------
// Drift detection (mirrors app/src/lib/turn-policies/coder-policy.ts)
// ---------------------------------------------------------------------------

function hasCodeSignals(text: string): boolean {
  return (
    /\{\s*"tool"\s*:/.test(text) || /```/.test(text) || /\.[tj]sx?\b|\.py\b|\.json\b/.test(text)
  );
}

function detectCognitiveDrift(text: string): string | null {
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
  if (ratio > 0.3 && nonAsciiCount > 50 && !hasCodeSignals(trimmed)) {
    reasons.push(`Non-ASCII ratio ${(ratio * 100).toFixed(0)}% with no code references`);
  }

  if (trimmed.length > 1500 || trimmed.split('\n').length > 20) {
    if (!hasCodeSignals(trimmed)) {
      reasons.push('Extended prose without tool calls or code references');
    }
  }

  if (reasons.length >= 2) return reasons.join('; ');
  if (repeatedPattern && repeatedPattern[0].length / repeatedPattern[1].length >= 20) {
    return reasons[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// TurnPolicyRegistry
// ---------------------------------------------------------------------------

export class TurnPolicyRegistry {
  private policies: TurnPolicy[] = [];

  register(policy: TurnPolicy): void {
    this.policies.push(policy);
  }

  evaluateBeforeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: TurnContext,
  ): BeforeToolResult {
    for (const policy of this.policies) {
      if (!policy.beforeToolExec) continue;
      for (const hook of policy.beforeToolExec) {
        const result = hook(toolName, args, ctx);
        if (result) return result;
      }
    }
    return null;
  }

  evaluateAfterModel(response: string, ctx: TurnContext): AfterModelResult {
    for (const policy of this.policies) {
      if (!policy.afterModelCall) continue;
      for (const hook of policy.afterModelCall) {
        const result = hook(response, ctx);
        if (result) return result;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coder policy factory
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_DRIFT_ROUNDS = 2;

export function createCoderPolicy(): TurnPolicy {
  let consecutiveDriftRounds = 0;

  return {
    name: 'cli-coder-core',

    beforeToolExec: [
      (toolName: string, _args: Record<string, unknown>, ctx: TurnContext) => {
        if (!isVerificationPhase(ctx.phase)) return null;
        if (!MUTATION_TOOLS.has(toolName)) return null;
        return {
          action: 'deny' as const,
          reason: `Phase "${ctx.phase}" is verification-only. File mutations (${toolName}) are blocked. Run tests or diffs instead.`,
        };
      },
    ],

    afterModelCall: [
      // Drift detection
      (response: string, _ctx: TurnContext) => {
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
            summary: `[Stopped — cognitive drift detected for ${consecutiveDriftRounds} consecutive rounds. ${driftReason}. Task may be incomplete.]`,
          };
        }

        return {
          action: 'inject' as const,
          message: [
            '[POLICY: DRIFT_DETECTED]',
            `You are generating unrelated content instead of working on the task. ${driftReason}.`,
            'Stop and re-evaluate. Re-read your task and working memory, then either use a tool or summarize your progress.',
            '[/POLICY]',
          ].join('\n'),
        };
      },
    ],
  };
}
