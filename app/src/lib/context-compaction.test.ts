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
    const summary = extractSemanticSummaryLines([
      '[Tool Result — sandbox_exec]',
      'Command: npm test',
      'Exit code: 1',
      '```',
      'very long stack trace',
      '```',
      'src/foo.test.ts',
    ].join('\n'), {
      includeHeader: true,
      includeOmissionMarker: true,
      maxLines: 4,
    });

    expect(summary).toEqual([
      '[Tool Result — sandbox_exec]',
      'Command: npm test',
      'Exit code: 1',
      '[code/content summarized]',
    ]);
  });
});

describe('compactChatMessage', () => {
  it('summarizes verbose assistant messages semantically instead of keeping only first lines', () => {
    const original = msg('assistant-1', 'assistant', [
      'I inspected the auth flow and the main issue is stale token refresh state.',
      '',
      'Files referenced: app/src/hooks/useAuth.ts, app/src/lib/token-store.ts',
      '',
      'Next: wire the retry path through the refresh guard so expired sessions recover cleanly.',
      '',
      '```ts',
      'const huge = "payload";',
      '```',
    ].join('\n'));

    const compacted = compactChatMessage(original, { threshold: 120 });

    expect(compacted.content).toContain('Files referenced: app/src/hooks/useAuth.ts, app/src/lib/token-store.ts');
    expect(compacted.content).toContain('Next: wire the retry path through the refresh guard so expired sessions recover cleanly.');
    expect(compacted.content).toContain('[code/content summarized]');
    expect(compacted.content.length).toBeLessThan(original.content.length);
  });
});

describe('buildContextSummaryPoints', () => {
  it('builds semantic digest points for tool calls, tool results, and normal messages', () => {
    const points = buildContextSummaryPoints([
      msg('user-1', 'user', 'Please inspect auth and fix the retry path.'),
      msg('call-1', 'assistant', '{"tool":"sandbox_read_file","args":{"path":"/workspace/app/src/hooks/useAuth.ts"}}', { isToolCall: true }),
      msg('result-1', 'user', [
        '[Tool Result — sandbox_read_file]',
        'Path: /workspace/app/src/hooks/useAuth.ts',
        'Status: ok',
        '```ts',
        'file body',
        '```',
      ].join('\n'), { isToolResult: true }),
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
    const block = buildContextSummaryBlock([
      msg('assistant-1', 'assistant', 'I traced the bug to the refresh guard and need one more read.'),
      msg('result-1', 'user', [
        '[Tool Result — sandbox_exec]',
        'Command: npm test',
        'Exit code: 1',
        '```',
        'stack trace',
        '```',
      ].join('\n'), { isToolResult: true }),
    ], {
      header: '[Context trimmed]',
      intro: 'Earlier work was condensed.',
      footerLines: ['Current round: 4. Re-read any files you need before making further edits.'],
    });

    expect(block).toContain('[Context trimmed]');
    expect(block).toContain('- Assistant: I traced the bug to the refresh guard and need one more read.');
    expect(block).toContain('- [Tool Result — sandbox_exec] | Command: npm test');
    expect(block).toContain('Current round: 4. Re-read any files you need before making further edits.');
  });
});
