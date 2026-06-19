import { describe, expect, it } from 'vitest';

import { getToolTargetDetail } from './tool-target-detail';

describe('getToolTargetDetail', () => {
  it('extracts targets from canonical and public tool names', () => {
    expect(getToolTargetDetail('sandbox_exec', { command: 'npm test' })).toBe('npm test');
    expect(getToolTargetDetail('exec', { command: 'npm test' })).toBe('npm test');
    expect(getToolTargetDetail('web', { query: 'latest React release' })).toBe(
      'latest React release',
    );
    expect(getToolTargetDetail('coder', { task: 'Fix the flaky auth test' })).toBe(
      'Fix the flaky auth test',
    );
  });

  it('truncates long targets', () => {
    const detail = getToolTargetDetail('exec', { command: 'x'.repeat(80) });
    expect(detail).toHaveLength(60);
    expect(detail?.endsWith('\u2026')).toBe(true);
  });
});
