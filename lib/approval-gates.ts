/**
 * Approval gate registry — runtime enforcement for approval-sensitive
 * actions. Lives in `lib/` so both web and CLI can register the same
 * gates against the same default rules.
 *
 * Gates are evaluated AFTER pre-hooks but BEFORE tool execution in
 * each surface's runtime adapter. They complement (don't replace)
 * existing guards like git guard and Protect Main, which run as
 * pre-hooks.
 *
 * Each gate returns 'allowed', 'blocked', or 'ask_user'. The first
 * non-allowed result short-circuits evaluation.
 *
 * Per-surface bindings inject:
 *   - `modeProvider`: returns the current `ApprovalMode`. Web reads
 *     safeStorage; CLI reads its config.
 */

import { getToolCapabilities, CAPABILITY_LABELS, type Capability } from './capabilities.ts';
import type { ToolHookContext } from './tool-hooks.ts';

// ---------------------------------------------------------------------------
// Approval mode — surface-agnostic vocabulary
// ---------------------------------------------------------------------------

export type ApprovalMode = 'supervised' | 'autonomous' | 'full-auto';

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

export type ApprovalGateCategory =
  | 'destructive_sandbox'
  | 'git_override'
  | 'remote_side_effect'
  | 'capability_violation';

export type ApprovalGateDecision = 'allowed' | 'blocked' | 'ask_user';

export interface ApprovalGateRule {
  id: string;
  label: string;
  category: ApprovalGateCategory;
  matcher: RegExp | string;
  evaluate: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolHookContext,
  ) => ApprovalGateDecision | Promise<ApprovalGateDecision>;
  blockedReason: string;
  recoveryPath: string;
}

export interface ApprovalGateBlockedResult {
  gateId: string;
  category: ApprovalGateCategory;
  decision: 'blocked' | 'ask_user';
  reason: string;
  recoveryPath: string;
}

// ---------------------------------------------------------------------------
// Destructive command detection
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive.*--force|--force.*--recursive)\b/, // rm -rf variants
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/, // rm -fr
  /\bgit\s+clean\s+-[a-zA-Z]*f/, // git clean -f
  /\bgit\s+reset\s+--hard\b/, // git reset --hard
  /\bgit\s+checkout\s+--\s*\./, // git checkout -- .
  // Anchor `.` so it terminates the argument: reject a following slash
  // (e.g. `./path`) or word char (e.g. `.config`), but accept anything
  // else — whitespace, end-of-string, or shell separators like `;`, `|`,
  // `&&` that `bash -c` accepts without a preceding space.
  /\bgit\s+restore\s+\.(?![/\w])/, // git restore .
  // `\b-delete` fails when `-delete` is preceded by whitespace (both
  // sides non-word, no word boundary). Require whitespace before
  // `-delete`.
  /\bfind\b.*\s-delete\b/, // find ... -delete
  /\btruncate\s/, // truncate
  />\s*\/dev\/null\b/, // > /dev/null
];

function isDestructiveCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ApprovalGateRegistry {
  private rules: ApprovalGateRule[] = [];

  register(rule: ApprovalGateRule): void {
    this.rules.push(rule);
  }

  async evaluate(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolHookContext,
  ): Promise<ApprovalGateBlockedResult | null> {
    for (const rule of this.rules) {
      const matches =
        rule.matcher instanceof RegExp
          ? rule.matcher.test(toolName)
          : toolName === rule.matcher || rule.matcher.split('|').includes(toolName);
      if (!matches) continue;

      const decision = await rule.evaluate(toolName, args, context);
      if (decision === 'allowed') continue;

      return {
        gateId: rule.id,
        category: rule.category,
        decision,
        reason: rule.blockedReason,
        recoveryPath: rule.recoveryPath,
      };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default rules factory
// ---------------------------------------------------------------------------

export interface ApprovalGateOptions {
  /**
   * Returns the current approval mode. Web wires `getApprovalMode()`
   * (safeStorage-backed); CLI wires a config-derived provider.
   */
  modeProvider: () => ApprovalMode;
}

export function createDefaultApprovalGates(options: ApprovalGateOptions): ApprovalGateRegistry {
  const registry = new ApprovalGateRegistry();
  const getMode = options.modeProvider;

  registry.register({
    id: 'destructive-sandbox-exec',
    label: 'Destructive sandbox command',
    category: 'destructive_sandbox',
    matcher: 'sandbox_exec',
    evaluate: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolHookContext,
    ): ApprovalGateDecision => {
      void toolName;
      void context;
      if (!isDestructiveCommand(args.command)) return 'allowed';
      const mode = getMode();
      if (mode === 'full-auto' || mode === 'autonomous') return 'allowed';
      return 'ask_user';
    },
    blockedReason:
      'This command matches a destructive pattern (rm -rf, git reset --hard, etc.) and requires explicit approval in supervised mode.',
    recoveryPath:
      'Use ask_user to explain the destructive action and get approval before re-running.',
  });

  registry.register({
    id: 'git-direct-override',
    label: 'Direct git command override',
    category: 'git_override',
    matcher: 'sandbox_exec',
    evaluate: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolHookContext,
    ): ApprovalGateDecision => {
      void toolName;
      void context;
      if (args.allowDirectGit !== true) return 'allowed';
      const mode = getMode();
      if (mode === 'full-auto' || mode === 'autonomous') return 'allowed';
      return 'ask_user';
    },
    blockedReason:
      'Direct git commands (allowDirectGit: true) bypass the standard git guard and require explicit approval in supervised mode.',
    recoveryPath:
      'Use ask_user to explain the git operation and why it needs the direct override, then re-run with approval.',
  });

  registry.register({
    id: 'remote-side-effect',
    label: 'Remote side effect',
    category: 'remote_side_effect',
    matcher: 'sandbox_push|pr_create|pr_merge|branch_delete|workflow_run',
    evaluate: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolHookContext,
    ): ApprovalGateDecision => {
      void toolName;
      void args;
      void context;
      const mode = getMode();
      if (mode === 'full-auto' || mode === 'autonomous') return 'allowed';
      return 'ask_user';
    },
    blockedReason:
      'This action causes a remote side effect (push, PR, branch deletion, workflow) and requires explicit approval in supervised mode.',
    recoveryPath:
      'Use ask_user to describe the remote action and its consequences, then re-run with approval.',
  });

  registry.register({
    id: 'capability-violation',
    label: 'Capability violation',
    category: 'capability_violation',
    matcher: /.*/,
    evaluate: (
      toolName: string,
      _args: Record<string, unknown>,
      context: ToolHookContext,
    ): ApprovalGateDecision => {
      const ledger = context.capabilityLedger;
      if (!ledger) return 'allowed';
      if (ledger.isToolAllowed(toolName)) return 'allowed';
      return 'blocked';
    },
    blockedReason: 'This tool requires capabilities not declared for this run.',
    recoveryPath:
      'The agent should use only tools within its declared capability set, or the delegation should be re-issued with broader capabilities.',
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Human-readable capability descriptions for approval prompts
// ---------------------------------------------------------------------------

export function describeToolCapabilities(canonicalToolName: string): string {
  const caps = getToolCapabilities(canonicalToolName);
  if (caps.length === 0) return canonicalToolName;
  return caps.map((cap) => CAPABILITY_LABELS[cap as Capability] ?? cap).join(', ');
}

export function buildCapabilityApprovalPrompt(canonicalToolNames: string[]): string {
  const allCaps = new Set<Capability>();
  for (const name of canonicalToolNames) {
    for (const cap of getToolCapabilities(name)) {
      allCaps.add(cap);
    }
  }
  if (allCaps.size === 0) return 'Allow this action?';
  const labels = Array.from(allCaps)
    .map((cap) => CAPABILITY_LABELS[cap] ?? cap)
    .filter(Boolean);
  if (labels.length === 0) return 'Allow this action?';
  if (labels.length === 1) return `Allow this run to ${labels[0]}?`;
  if (labels.length === 2) return `Allow this run to ${labels[0]} and ${labels[1]}?`;
  return `Allow this run to ${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}?`;
}
