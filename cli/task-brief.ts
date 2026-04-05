import { buildDelegationBrief } from '../lib/delegation-brief.ts';
import type { AcceptanceCriterion } from '../lib/runtime-contract.ts';

function buildAcceptanceCriteria(checks: string[]): AcceptanceCriterion[] | undefined {
  const normalized = checks
    .map((check) => String(check || '').trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.map((check, index) => ({
    id: `accept_${index + 1}`,
    check,
    description: `Exit 0: ${check}`,
  }));
}

export function buildHeadlessTaskBrief(task: string, acceptanceChecks: string[] = []): string {
  return buildDelegationBrief({
    task,
    acceptanceCriteria: buildAcceptanceCriteria(acceptanceChecks),
  });
}
