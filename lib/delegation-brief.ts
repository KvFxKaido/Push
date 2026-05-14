/**
 * Shared delegation-brief formatting for Coder and Explorer handoffs.
 *
 * This is the narrow semantic contract for how Push describes delegated
 * work to a sub-agent. Reviewer/Auditor context blocks remain shell-local.
 */

import { ROLE_CAPABILITIES, formatCapabilities } from './capabilities.js';
import type { AcceptanceCriterion, AgentRole } from './runtime-contract.js';

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
  const lines = [`Task: ${input.task}`];

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
