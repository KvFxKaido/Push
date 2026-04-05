import type {
  ChatCard,
  DelegationOutcome,
  DelegationResultCardData,
} from '@/types';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';

interface BuildDelegationResultOptions {
  agent: DelegationResultCardData['agent'];
  outcome: DelegationOutcome;
  fileCount?: number;
  taskCount?: number;
}

const INLINE_DELEGATION_CARD_TYPES: ReadonlySet<string> = new Set([
  'audit-verdict',
  'commit-review',
  'ask-user',
]);

function extractSection(summary: string, label: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Za-z][^\\n]*:\\*\\*|$)`, 'i');
  const match = summary.match(pattern)?.[1]?.trim();
  return match || undefined;
}

function isTrivialValue(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === 'nothing'
    || normalized === 'none'
    || normalized === 'not run'
    || normalized === 'n/a';
}

function stripSummaryNoise(summary: string): string {
  return summary
    .replace(/\n{0,2}\[Sandbox State][\s\S]*$/i, '')
    .replace(/\n{0,2}\[Acceptance Criteria][\s\S]*?(?=\n{2,}\[|$)/gi, '')
    .replace(/\n{0,2}\[Evaluation:[^\n]*](?:\n\s*-\s.*)*/gi, '')
    .replace(/\n\*\*Changed:\*\*.*?(?=\n\*\*[A-Za-z][^:\n]*:\*\*|$)/gis, '')
    .trim();
}

function buildCompactSummary(agent: DelegationResultCardData['agent'], summary: string): {
  summary: string;
  verifiedText?: string;
  openText?: string;
} {
  if (agent === 'coder') {
    const done = extractSection(summary, 'Done');
    const verified = extractSection(summary, 'Verified');
    const open = extractSection(summary, 'Open');
    return {
      summary: summarizeToolResultPreview(done ?? stripSummaryNoise(summary), 260),
      verifiedText: isTrivialValue(verified) ? undefined : verified,
      openText: isTrivialValue(open) ? undefined : open,
    };
  }

  return {
    summary: summarizeToolResultPreview(stripSummaryNoise(summary), 260),
  };
}

function getAgentLinePrefix(agent: DelegationResultCardData['agent']): string {
  switch (agent) {
    case 'explorer':
      return 'Explorer';
    case 'coder':
      return 'Coder';
    case 'task_graph':
      return 'Task graph';
  }
}

function getToolResultName(agent: DelegationResultCardData['agent']): string {
  switch (agent) {
    case 'explorer':
      return 'delegate_explorer';
    case 'coder':
      return 'delegate_coder';
    case 'task_graph':
      return 'plan_tasks';
  }
}

function getStatusLine(status: DelegationOutcome['status']): string {
  switch (status) {
    case 'complete':
      return 'complete';
    case 'incomplete':
      return 'needs follow-up';
    case 'inconclusive':
      return 'stopped early';
  }
}

export function filterDelegationCardsForInlineDisplay(cards: readonly ChatCard[]): ChatCard[] {
  return cards.filter((card) => INLINE_DELEGATION_CARD_TYPES.has(card.type));
}

export function buildDelegationResultCardData({
  agent,
  outcome,
  fileCount,
  taskCount,
}: BuildDelegationResultOptions): DelegationResultCardData {
  const compact = buildCompactSummary(agent, outcome.summary);
  const checksPassed = outcome.checks.filter((check) => check.passed).length;

  return {
    agent,
    status: outcome.status,
    summary: compact.summary,
    verifiedText: compact.verifiedText,
    openText: compact.openText,
    checksPassed: outcome.checks.length > 0 ? checksPassed : undefined,
    checksTotal: outcome.checks.length > 0 ? outcome.checks.length : undefined,
    fileCount,
    taskCount,
    rounds: outcome.rounds,
    checkpoints: outcome.checkpoints,
    elapsedMs: outcome.elapsedMs,
    gateVerdicts: outcome.gateVerdicts,
    missingRequirements: outcome.missingRequirements,
    nextRequiredAction: outcome.nextRequiredAction,
  };
}

export function buildDelegationResultCard(options: BuildDelegationResultOptions): ChatCard {
  return {
    type: 'delegation-result',
    data: buildDelegationResultCardData(options),
  };
}

export function formatCompactDelegationToolResult(options: BuildDelegationResultOptions): string {
  const data = buildDelegationResultCardData(options);
  const lines = [
    `[Tool Result — ${getToolResultName(options.agent)}]`,
    `${getAgentLinePrefix(options.agent)} ${getStatusLine(options.outcome.status)}: ${data.summary}`,
  ];

  if (typeof data.fileCount === 'number') {
    lines.push(`Files changed: ${data.fileCount}`);
  }

  if (typeof data.taskCount === 'number') {
    lines.push(`Tasks: ${data.taskCount}`);
  }

  if (typeof data.checksTotal === 'number' && typeof data.checksPassed === 'number') {
    lines.push(`Checks: ${data.checksPassed}/${data.checksTotal} passed`);
  }

  const auditorVerdict = data.gateVerdicts.find((verdict) => verdict.gate === 'auditor');
  if (auditorVerdict) {
    lines.push(`Auditor: ${auditorVerdict.outcome.toUpperCase()} — ${auditorVerdict.summary}`);
  }

  if (data.openText) {
    lines.push(`Open: ${data.openText}`);
  }

  if (data.nextRequiredAction) {
    lines.push(`Next: ${data.nextRequiredAction}`);
  }

  lines.push(
    `(${data.rounds} round${data.rounds === 1 ? '' : 's'}${data.checkpoints > 0 ? `, ${data.checkpoints} checkpoint${data.checkpoints === 1 ? '' : 's'}` : ''})`,
  );

  return lines.join('\n');
}
