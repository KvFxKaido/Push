import { describe, expect, it } from 'vitest';
import type { ChatCard, DelegationOutcome } from '@/types';
import {
  buildDelegationResultCardData,
  filterDelegationCardsForInlineDisplay,
  formatCompactDelegationToolResult,
} from './delegation-result';

function makeOutcome(overrides: Partial<DelegationOutcome> = {}): DelegationOutcome {
  return {
    agent: 'coder',
    status: 'complete',
    summary: '**Done:** Implemented the auth refresh fix.\n**Changed:** src/auth.ts, src/auth.test.ts\n**Verified:** npm test -- auth passed\n**Open:** nothing',
    evidence: [],
    checks: [
      { id: 'auth-tests', passed: true, exitCode: 0, output: 'ok' },
    ],
    gateVerdicts: [
      { gate: 'auditor', outcome: 'passed', summary: 'Looks complete.' },
    ],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: 4,
    checkpoints: 1,
    elapsedMs: 3200,
    ...overrides,
  };
}

describe('delegation-result helpers', () => {
  it('builds a compact coder card from the structured summary', () => {
    const data = buildDelegationResultCardData({
      agent: 'coder',
      outcome: makeOutcome(),
      fileCount: 2,
    });

    expect(data.summary).toBe('Implemented the auth refresh fix.');
    expect(data.verifiedText).toBe('npm test -- auth passed');
    expect(data.openText).toBeUndefined();
    expect(data.fileCount).toBe(2);
    expect(data.checksPassed).toBe(1);
    expect(data.checksTotal).toBe(1);
  });

  it('formats compact tool-result text without the raw changed-file transcript', () => {
    const text = formatCompactDelegationToolResult({
      agent: 'coder',
      outcome: makeOutcome(),
      fileCount: 2,
    });

    expect(text).toContain('[Tool Result — delegate_coder]');
    expect(text).toContain('Coder complete: Implemented the auth refresh fix.');
    expect(text).toContain('Files changed: 2');
    expect(text).toContain('Checks: 1/1 passed');
    expect(text).not.toContain('**Changed:**');
    expect(text).not.toContain('src/auth.ts, src/auth.test.ts');
  });

  it('keeps only actionable delegated cards inline in chat', () => {
    const cards = [
      { type: 'test-results', data: { framework: 'npm', output: '', exitCode: 0, durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, truncated: false } },
      { type: 'diff-preview', data: { diff: 'diff --git', filesChanged: 1, additions: 1, deletions: 0, truncated: false } },
      { type: 'audit-verdict', data: { verdict: 'safe', summary: 'ok', risks: [], filesReviewed: 1 } },
      { type: 'ask-user', data: { question: 'Need input?', options: [{ id: 'yes', label: 'Yes' }] } },
    ] as ChatCard[];

    expect(filterDelegationCardsForInlineDisplay(cards)).toEqual([
      cards[2],
      cards[3],
    ]);
  });
});
