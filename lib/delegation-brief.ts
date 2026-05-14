/**
 * Shared delegation-brief formatting for Coder and Explorer handoffs.
 *
 * This is the narrow semantic contract for how Push describes delegated
 * work to a sub-agent. Reviewer/Auditor context blocks remain shell-local.
 */

import { ROLE_CAPABILITIES, formatCapabilities } from './capabilities.js';
import type { AcceptanceCriterion, AgentRole } from './runtime-contract.js';
import { formatUserGoalBlock, type UserGoalAnchor } from './user-goal-anchor.ts';

export interface DelegationBriefInput {
  task: string;
  intent?: string;
  deliverable?: string;
  knownContext?: string[];
  constraints?: string[];
  files?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * Role the brief is being addressed to. When set, the brief includes
   * an explicit `Capabilities:` line derived from `ROLE_CAPABILITIES`,
   * so the delegated agent sees its grant in its system prompt rather
   * than only learning its limits by hitting `ROLE_CAPABILITY_DENIED`
   * at runtime — the silent-failure mode that drives delegated agents
   * to hallucinate tools they aren't allowed to use.
   */
  targetRole?: AgentRole;
  /**
   * The orchestrator-level user goal that motivated this delegation. When
   * present, the brief renders the formatted `[USER_GOAL]` block ahead of
   * the per-node task description so Coder / Explorer see the same goal
   * constraint the orchestrator was bound by. Without this, delegated
   * agents see only their slice and the layering (goal -> task-graph ->
   * delegation) stops being load-bearing at the boundary.
   */
  userGoal?: UserGoalAnchor;
  /**
   * The orchestrator's per-task rationale from the `addresses` field on
   * the source `TaskGraphNode`. Rendered alongside `userGoal` so the
   * delegated agent can see *why* this slice was chosen, not just *what*
   * the slice is. Soft-fails (omits the line) when absent so legacy
   * callers without `addresses` keep working.
   */
  addresses?: string;
}

export function formatAcceptanceCriteria(criteria?: AcceptanceCriterion[]): string[] {
  if (!criteria || criteria.length === 0) return [];
  return criteria.map((criterion) => {
    const description = criterion.description?.trim();
    if (description) return `${criterion.id}: ${description}`;
    return `${criterion.id}: ${criterion.check}`;
  });
}

export function buildDelegationBrief(input: DelegationBriefInput): string {
  const lines: string[] = [];

  // User goal is rendered first so the delegated agent reads it before
  // the per-node task description — same proximity story the
  // orchestrator-level anchor solves, applied one layer down.
  if (input.userGoal) {
    lines.push(formatUserGoalBlock(input.userGoal));
    lines.push('');
  }

  lines.push(`Task: ${input.task}`);

  const addresses = input.addresses?.trim();
  if (addresses) {
    lines.push('', `Addresses: ${addresses}`);
  }

  if (input.targetRole) {
    const grant = ROLE_CAPABILITIES[input.targetRole];
    if (grant && grant.size > 0) {
      lines.push('', `Capabilities: ${formatCapabilities(grant)}`);
    }
  }

  if (input.intent?.trim()) {
    lines.push('', `Intent: ${input.intent.trim()}`);
  }
  if (input.deliverable?.trim()) {
    lines.push('', `Deliverable: ${input.deliverable.trim()}`);
  }
  if (input.knownContext && input.knownContext.length > 0) {
    lines.push('', 'Known context:');
    lines.push(
      ...input.knownContext.map((item) => {
        if (item.includes('\n')) return item;
        return `- ${item}`;
      }),
    );
  }
  if (input.constraints && input.constraints.length > 0) {
    lines.push('', 'Constraints:');
    lines.push(...input.constraints.map((constraint) => `- ${constraint}`));
  }
  if (input.files && input.files.length > 0) {
    lines.push('', `Relevant files: ${input.files.join(', ')}`);
  }
  const acceptanceLines = formatAcceptanceCriteria(input.acceptanceCriteria);
  if (acceptanceLines.length > 0) {
    lines.push('', 'Acceptance checks:');
    lines.push(...acceptanceLines.map((line) => `- ${line}`));
  }

  return lines.join('\n');
}
