import { buildDelegationBrief } from '../lib/delegation-brief.ts';
import type { AcceptanceCriterion } from '../lib/runtime-contract.ts';
import type { UserGoalAnchor } from '../lib/user-goal-anchor.ts';

function buildAcceptanceCriteria(checks: string[]): AcceptanceCriterion[] | undefined {
  const normalized = checks.map((check) => String(check || '').trim()).filter(Boolean);

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.map((check, index) => ({
    id: `accept_${index + 1}`,
    check,
    description: `Exit 0: ${check}`,
  }));
}

export interface HeadlessTaskBriefOptions {
  /**
   * User-goal anchor for this delegation. When present, the brief renders
   * a `[USER_GOAL]` block above the task description so the Coder sees
   * the same goal constraint the planner was bound by. Matches the web
   * task-graph-delegation-handler pattern. See PR #550 / docs/decisions/
   * Goal-Anchored Task Graph Layering.md.
   */
  userGoal?: UserGoalAnchor;
  /**
   * Per-task rationale from the planner's `feature.addresses` (which
   * `cli/delegation-entry.ts:planToTaskGraph` propagates onto
   * `TaskGraphNode.addresses`). Rendered as `Addresses: <text>` next to
   * `Task:` in the brief. Soft-fails when absent — legacy non-graph CLI
   * delegations and pre-`addresses` planner output keep working.
   */
  addresses?: string;
}

export function buildHeadlessTaskBrief(
  task: string,
  acceptanceChecks: string[] = [],
  options: HeadlessTaskBriefOptions = {},
): string {
  return buildDelegationBrief({
    task,
    acceptanceCriteria: buildAcceptanceCriteria(acceptanceChecks),
    targetRole: 'coder',
    userGoal: options.userGoal,
    addresses: options.addresses,
  });
}
