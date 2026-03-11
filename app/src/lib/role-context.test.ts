import { describe, expect, it } from 'vitest';
import {
  buildAuditorContextBlock,
  buildReviewerContextBlock,
} from './role-context';

describe('buildReviewerContextBlock', () => {
  it('includes provenance and trimmed project policy hints', () => {
    const block = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      activeBranch: 'feature/test',
      defaultBranch: 'main',
      source: 'pr-diff',
      sourceLabel: 'PR #42 Improve review context',
      projectInstructions: '# AGENTS.md\n\n## Testing\n- Run npm test\n',
    });

    expect(block).toContain('Repo: owner/repo');
    expect(block).toContain('Diff source: Open PR diff from GitHub.');
    expect(block).toContain('Source label: PR #42 Improve review context');
    expect(block).toContain('## Project Policy Hints');
    expect(block).toContain('Run npm test');
  });
});

describe('buildAuditorContextBlock', () => {
  it('includes trust-boundary guidance even without project instructions', () => {
    const block = buildAuditorContextBlock({
      source: 'working-tree-commit',
      sourceLabel: 'Working tree diff before commit/push',
    });

    expect(block).toContain('Audit source: Working tree diff before a standard commit/push.');
    expect(block).toContain('do not override core safety concerns');
  });
});
