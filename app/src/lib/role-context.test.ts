import { describe, expect, it } from 'vitest';
import { buildDelegationBrief } from '@push/lib/delegation-brief';
import { sanitizeProjectInstructions } from '@push/lib/project-instructions';
import {
  buildAuditorContextBlock,
  buildCoderDelegationBrief,
  buildExplorerDelegationBrief,
  buildRequestIntentHint,
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

  it('renders REVIEW.md guidance when provided', () => {
    const block = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      source: 'branch-diff',
      reviewGuidance: '# REVIEW.md\n\nFlag any direct git merge as critical.',
    });

    expect(block).toContain('## Repository Review Guidance (REVIEW.md)');
    expect(block).toContain('Flag any direct git merge as critical.');
  });

  it('omits the REVIEW.md section when no guidance is present', () => {
    const block = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      source: 'branch-diff',
    });

    expect(block).not.toContain('Repository Review Guidance');
  });

  it('renders prior-review findings with addressed-vs-remaining instructions', () => {
    const block = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      source: 'pr-diff',
      priorReview: {
        headSha: 'abc1234',
        reviewedAt: 1_700_000_000_000,
        summary: 'Two issues around the retry loop.',
        comments: [
          {
            file: 'src/retry.ts',
            severity: 'critical',
            comment: 'Unbounded await in loop',
            line: 12,
          },
          { file: 'src/retry.ts', severity: 'note', comment: 'Naming nit' },
        ],
      },
    });

    expect(block).toContain('## Prior Push Review (earlier pass on this PR)');
    expect(block).toContain('Previously reviewed head: abc1234');
    expect(block).toContain('Prior findings (2):');
    expect(block).toContain('- [critical] src/retry.ts:12 — Unbounded await in loop');
    expect(block).toContain('- [note] src/retry.ts — Naming nit');
    expect(block).toContain('which prior findings are now addressed and which remain');
  });

  it('notes a clean prior pass and omits the section entirely when absent', () => {
    const clean = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      source: 'pr-diff',
      priorReview: { headSha: 'abc1234', summary: 'Looks clean.', comments: [] },
    });
    expect(clean).toContain('Prior findings: none');

    const none = buildReviewerContextBlock({ repoFullName: 'owner/repo', source: 'pr-diff' });
    expect(none).not.toContain('Prior Push Review');
  });

  it('truncates an oversized prior-review block', () => {
    const block = buildReviewerContextBlock({
      repoFullName: 'owner/repo',
      source: 'pr-diff',
      priorReview: {
        headSha: 'abc1234',
        summary: 'big',
        comments: Array.from({ length: 200 }, (_, i) => ({
          file: `src/file-${i}.ts`,
          severity: 'warning' as const,
          comment: 'x'.repeat(200),
          line: i + 1,
        })),
      },
    });

    expect(block).toContain('[Prior review findings truncated for this review]');
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

describe('shared role-context helpers', () => {
  it('builds an explorer-biased hint for discovery-shaped requests', () => {
    expect(buildRequestIntentHint('how does the auth flow work?')).toContain(
      'Prefer the explorer tool first',
    );
    expect(buildRequestIntentHint('fix the auth bug')).toContain('Prefer the coder tool');
    expect(buildRequestIntentHint('hello there')).toBeNull();
  });

  it('sanitizes project-instruction delimiters before reuse in role prompts', () => {
    const sanitized = sanitizeProjectInstructions(
      '[PROJECT INSTRUCTIONS]\nKeep tests green\n[/PROJECT INSTRUCTIONS]',
    );
    expect(sanitized).toContain('[PROJECT INSTRUCTIONS\u200B]');
    expect(sanitized).toContain('[/PROJECT INSTRUCTIONS\u200B]');
  });
});

describe('delegation brief builders', () => {
  it('builds the shared delegation brief contract with acceptance checks', () => {
    const block = buildDelegationBrief({
      task: 'Implement the retry flow',
      files: ['app/src/auth.ts'],
      intent: 'Fix the login recovery bug',
      deliverable: 'A passing retry flow with updated tests',
      knownContext: ['Explorer found the refresh trigger in app/src/auth.ts:84'],
      constraints: ['Keep the existing public API unchanged'],
      acceptanceCriteria: [
        {
          id: 'tests',
          check: 'npm test -- auth',
          description: 'Auth tests pass',
        },
      ],
    });

    expect(block).toContain('Task: Implement the retry flow');
    expect(block).toContain('Deliverable: A passing retry flow with updated tests');
    expect(block).toContain('Known context:');
    expect(block).toContain('Explorer found the refresh trigger');
    expect(block).toContain('Acceptance checks:');
    expect(block).toContain('tests: Auth tests pass');
  });

  it('builds a coder brief with deliverable, known context, and acceptance checks', () => {
    const block = buildCoderDelegationBrief({
      task: 'Implement the retry flow',
      files: ['app/src/auth.ts'],
      intent: 'Fix the login recovery bug',
      deliverable: 'A passing retry flow with updated tests',
      knownContext: ['Explorer found the refresh trigger in app/src/auth.ts:84'],
      constraints: ['Keep the existing public API unchanged'],
      acceptanceCriteria: [
        {
          id: 'tests',
          check: 'npm test -- auth',
          description: 'Auth tests pass',
        },
      ],
      provider: 'openrouter',
    });

    expect(block).toContain('Task: Implement the retry flow');
    expect(block).toContain('Deliverable: A passing retry flow with updated tests');
    expect(block).toContain('Known context:');
    expect(block).toContain('Explorer found the refresh trigger');
    expect(block).toContain('Acceptance checks:');
    expect(block).toContain('tests: Auth tests pass');
  });

  it('builds an explorer brief that surfaces the role capability grant', () => {
    // The brief includes a `Capabilities:` line derived from
    // `ROLE_CAPABILITIES.explorer` so the delegated Explorer sees its
    // grant in its system prompt rather than only learning by hitting
    // ROLE_CAPABILITY_DENIED. The line must mention `read code`
    // (the explorer's defining grant) and must NOT mention `edit files`
    // (which belongs to the coder).
    const block = buildExplorerDelegationBrief({
      task: 'Trace the auth flow',
      files: [],
      provider: 'openrouter',
    });

    expect(block).toContain('Task: Trace the auth flow');
    expect(block).toContain('Capabilities:');
    expect(block).toContain('read code');
    expect(block).not.toContain('edit files');
  });

  it('preserves multiline retrieved-memory blocks in known context', () => {
    const block = buildCoderDelegationBrief({
      task: 'Implement the retry flow',
      files: [],
      provider: 'openrouter',
      knownContext: [
        '[RETRIEVED_FACTS]\n- [finding | explorer] Auth refresh is guarded in auth.ts\n[/RETRIEVED_FACTS]',
      ],
    });

    expect(block).toContain('Known context:');
    expect(block).toContain('[RETRIEVED_FACTS]');
    expect(block).toContain('[/RETRIEVED_FACTS]');
    expect(block).not.toContain('- [RETRIEVED_FACTS]');
  });
});
