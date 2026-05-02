import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/types';
import {
  buildContextSummaryBlock,
  buildContextSummaryPoints,
  compactChatMessage,
  extractSemanticSummaryLines,
} from './context-compaction';

function msg(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extras,
  };
}

describe('extractSemanticSummaryLines', () => {
  it('keeps salient tool-result lines and replaces verbose payloads with a semantic marker', () => {
    const summary = extractSemanticSummaryLines(
      [
        '[Tool Result — sandbox_exec]',
        'Command: npm test',
        'Exit code: 1',
        '```',
        'very long stack trace',
        '```',
        'src/foo.test.ts',
      ].join('\n'),
      {
        includeHeader: true,
        includeOmissionMarker: true,
        maxLines: 4,
      },
    );

    expect(summary).toEqual([
      '[Tool Result — sandbox_exec]',
      'Command: npm test',
      'Exit code: 1',
      '[code/content summarized]',
    ]);
  });
});

describe('extractSemanticSummaryLines — list-aware omission marker', () => {
  // Regression: a 10-commit list_commits result was being compacted to
  // ~3 visible lines with the generic '[additional content summarized]'
  // marker. On the next turn the model saw a 3-item excerpt and
  // hallucinated a 'policy' to rationalize the gap from its prior 10-
  // commit reasoning. The marker must carry the original count plus
  // the 'sample, not the complete result' framing so the next turn has
  // the right epistemic status.
  it('replaces the generic marker with a count-aware sample notice for list_commits', () => {
    const tenCommits = [
      '[Tool Result — list_commits]',
      '10 recent commits on KvFxKaido/Push:',
      '',
      'a530f19 Merge pull request #474 from KvFxKaido/claude/verification-not-applicable-readonly',
      '  by claude | 5/2/2026',
      '344f39d fix(orchestrator): scope mutationOccurred to real workspace mutations only',
      '  by claude | 5/2/2026',
      '7eb3b28 fix(orchestrator): address PR #474 review feedback',
      '  by claude | 5/2/2026',
      '6aefc15 fix(orchestrator): defer evidence rules until a mutation occurs',
      '  by claude | 5/2/2026',
      '512cf42 Merge pull request #473',
      '  by claude | 5/2/2026',
      '66895d9 fix(orchestrator): keep bare past-tense detection',
      '  by claude | 5/2/2026',
      'f258506 fix(orchestrator): stop verification loop on read-only summary turns',
      '  by claude | 5/2/2026',
      '4cee36e Merge pull request #472',
      '  by claude | 5/1/2026',
      'f6e3b8c docs(context): correct three runtime claims',
      '  by claude | 5/1/2026',
      'b37f2ed docs: expand CLAUDE.md',
      '  by claude | 5/1/2026',
    ].join('\n');

    const summary = extractSemanticSummaryLines(tenCommits, {
      includeHeader: true,
      includeOmissionMarker: true,
      maxLines: 5,
    });

    const marker = summary[summary.length - 1];
    expect(marker).toContain('omitted from original 10-item list');
    expect(marker).toContain('commits');
    expect(marker).toContain('sample, not the complete result');
    expect(marker).toContain('re-run list_commits');
    // The generic marker must NOT appear — that's the failure mode
    // that let the model rationalize the gap.
    expect(marker).not.toContain('[additional content summarized]');
  });

  it('falls back to the explicit total when item-start pattern is unknown', () => {
    // Branches don't have a per-noun item-start regex yet, so the
    // marker should still surface the original count + sample framing
    // rather than the generic wording.
    const branches = [
      '[Tool Result — list_branches]',
      '8 branches on KvFxKaido/Push (default: main):',
      '',
      'main — protected, default',
      'claude/fix-1 — open',
      'claude/fix-2 — open',
      'claude/fix-3 — open',
      'claude/fix-4 — open',
      'claude/fix-5 — open',
      'claude/fix-6 — open',
      'claude/fix-7 — open',
    ].join('\n');

    const summary = extractSemanticSummaryLines(branches, {
      includeHeader: true,
      includeOmissionMarker: true,
      maxLines: 5,
    });

    const marker = summary[summary.length - 1];
    expect(marker).toContain('Original list had 8 branches');
    expect(marker).toContain('sample, not the complete result');
    expect(marker).toContain('re-run list_branches');
  });

  it('leaves non-list tool results on the existing markers', () => {
    // Sanity check: the list-aware marker must not regress sandbox_exec
    // / read_file / etc. that don't have a count header.
    const sandboxExec = [
      '[Tool Result — sandbox_exec]',
      'Command: npm test',
      'Exit code: 1',
      '```',
      'very long stack trace',
      '```',
    ].join('\n');

    const summary = extractSemanticSummaryLines(sandboxExec, {
      includeHeader: true,
      includeOmissionMarker: true,
      maxLines: 4,
    });

    expect(summary[summary.length - 1]).toBe('[code/content summarized]');
  });
});

describe('compactChatMessage', () => {
  it('summarizes verbose assistant messages semantically instead of keeping only first lines', () => {
    const original = msg(
      'assistant-1',
      'assistant',
      [
        'I inspected the auth flow and the main issue is stale token refresh state.',
        '',
        'Files referenced: app/src/hooks/useAuth.ts, app/src/lib/token-store.ts',
        '',
        'Next: wire the retry path through the refresh guard so expired sessions recover cleanly.',
        '',
        '```ts',
        'const huge = "payload";',
        '```',
      ].join('\n'),
    );

    const compacted = compactChatMessage(original, { threshold: 120 });

    expect(compacted.content).toContain(
      'Files referenced: app/src/hooks/useAuth.ts, app/src/lib/token-store.ts',
    );
    expect(compacted.content).toContain(
      'Next: wire the retry path through the refresh guard so expired sessions recover cleanly.',
    );
    expect(compacted.content).toContain('[code/content summarized]');
    expect(compacted.content.length).toBeLessThan(original.content.length);
  });
});

describe('buildContextSummaryPoints', () => {
  it('builds semantic digest points for tool calls, tool results, and normal messages', () => {
    const points = buildContextSummaryPoints([
      msg('user-1', 'user', 'Please inspect auth and fix the retry path.'),
      msg(
        'call-1',
        'assistant',
        '{"tool":"sandbox_read_file","args":{"path":"/workspace/app/src/hooks/useAuth.ts"}}',
        { isToolCall: true },
      ),
      msg(
        'result-1',
        'user',
        [
          '[Tool Result — sandbox_read_file]',
          'Path: /workspace/app/src/hooks/useAuth.ts',
          'Status: ok',
          '```ts',
          'file body',
          '```',
        ].join('\n'),
        { isToolResult: true },
      ),
    ]);

    expect(points).toEqual([
      '- User: Please inspect auth and fix the retry path.',
      '- Assistant requested sandbox_read_file.',
      '- [Tool Result — sandbox_read_file] | Path: /workspace/app/src/hooks/useAuth.ts',
    ]);
  });
});

describe('buildContextSummaryBlock', () => {
  it('assembles a reusable summary block for trimmed coder context', () => {
    const block = buildContextSummaryBlock(
      [
        msg(
          'assistant-1',
          'assistant',
          'I traced the bug to the refresh guard and need one more read.',
        ),
        msg(
          'result-1',
          'user',
          [
            '[Tool Result — sandbox_exec]',
            'Command: npm test',
            'Exit code: 1',
            '```',
            'stack trace',
            '```',
          ].join('\n'),
          { isToolResult: true },
        ),
      ],
      {
        header: '[Context trimmed]',
        intro: 'Earlier work was condensed.',
        footerLines: ['Current round: 4. Re-read any files you need before making further edits.'],
      },
    );

    expect(block).toContain('[Context trimmed]');
    expect(block).toContain(
      '- Assistant: I traced the bug to the refresh guard and need one more read.',
    );
    expect(block).toContain('- [Tool Result — sandbox_exec] | Command: npm test');
    expect(block).toContain(
      'Current round: 4. Re-read any files you need before making further edits.',
    );
  });
});
