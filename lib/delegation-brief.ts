/**
 * Shared delegation-brief formatting for Coder and Explorer handoffs.
 *
 * This is the narrow semantic contract for how Push describes delegated
 * work to a sub-agent. Reviewer/Auditor context blocks remain shell-local.
 */

import type { AcceptanceCriterion } from './runtime-contract.js';

export interface DelegationBriefInput {
  task: string;
  intent?: string;
  deliverable?: string;
  knownContext?: string[];
  constraints?: string[];
  files?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
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
