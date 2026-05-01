import { describe, expect, it } from 'vitest';
import {
  buildContextSummaryBlock,
  extractSemanticSummaryLines,
  normalizeTrimmedRoleAlternation,
  type CoderContextMessage,
} from './coder-context-trim.js';

function msg(
  id: string,
  role: CoderContextMessage['role'],
  content: string,
  extras: Partial<CoderContextMessage> = {},
): CoderContextMessage {
  return {
    id,
    role,
    content,
    timestamp: 1,
    ...extras,
  };
}

describe('coder context trim helpers', () => {
  it('summarizes important lines and marks omitted diff content', () => {
    const lines = extractSemanticSummaryLines(
      [
        '[Tool Result - sandbox_diff]',
        'diff --git a/app.ts b/app.ts',
        '+changed code',
        'Status: working tree changed',
        'Summary: updated app/src/app.ts',
      ].join('\n'),
      { includeHeader: true, includeOmissionMarker: true, maxLines: 3 },
    );

    expect(lines).toEqual([
      '[Tool Result - sandbox_diff]',
      'Status: working tree changed',
      '[diff content summarized]',
    ]);
  });

  it('builds context points for tool calls and tool results', () => {
    const block = buildContextSummaryBlock(
      [
        msg('call', 'assistant', '{"tool":"sandbox_read_file","args":{"path":"app/src/app.ts"}}', {
          isToolCall: true,
        }),
        msg('result', 'user', '[Tool Result - sandbox_read_file]\nPath: app/src/app.ts\nok', {
          isToolResult: true,
        }),
      ],
      { header: '[Context trimmed]', maxPoints: 4 },
    );

    expect(block).toContain('- Assistant requested sandbox_read_file.');
    expect(block).toContain('- [Tool Result - sandbox_read_file] | Path: app/src/app.ts');
  });

  it('returns no lines when the content is empty', () => {
    expect(extractSemanticSummaryLines('')).toEqual([]);
    expect(extractSemanticSummaryLines('\n  \n\t\n')).toEqual([]);
  });

  it('picks up bullets in the first pass when their syntax does not conflict with diff markers', () => {
    // `- foo` and `+ foo` are ambiguous: markdown bullets AND unified-diff +/-
    // lines. The function classifies them as diff content (via `-[^-]` /
    // `\+[^+]`) before the bullet check runs. Asterisk and numbered bullets
    // are unambiguous; this test pins both branches of BULLET_RE.
    const lines = extractSemanticSummaryLines(
      ['* alpha bullet', '* beta bullet', '1. numbered bullet'].join('\n'),
      { maxLines: 5 },
    );
    expect(lines).toEqual(['* alpha bullet', '* beta bullet', '1. numbered bullet']);
  });

  it('classifies dash-prefixed lines as diff content rather than bullets (documented ambiguity)', () => {
    // Companion to the previous test — `- foo` lines are intentionally
    // consumed as diff. With includeOmissionMarker the marker reflects this.
    const lines = extractSemanticSummaryLines(
      ['Status: ok', '- removed alpha', '- removed beta'].join('\n'),
      { maxLines: 4, includeOmissionMarker: true },
    );
    expect(lines).toContain('Status: ok');
    expect(lines).toContain('[diff content summarized]');
    expect(lines.some((line) => line.startsWith('- removed'))).toBe(false);
  });

  it('falls through to the second pass for plain text without prefixes or bullets', () => {
    const lines = extractSemanticSummaryLines(
      ['just some text here', 'another sentence', 'and a third'].join('\n'),
      { maxLines: 4 },
    );
    expect(lines).toEqual(['just some text here', 'another sentence', 'and a third']);
  });

  it('marks code-fenced content with the [code/content summarized] omission marker (not the diff variant)', () => {
    const lines = extractSemanticSummaryLines(
      ['Status: ok', '```ts', 'console.log("inside")', '```'].join('\n'),
      { maxLines: 3, includeOmissionMarker: true },
    );
    expect(lines).toContain('Status: ok');
    expect(lines[lines.length - 1]).toBe('[code/content summarized]');
  });

  it('falls back to a "Files referenced:" line when paths only appear in skipped diff content', () => {
    const lines = extractSemanticSummaryLines(
      ['Status: ok', '+ added /workspace/app/foo.ts to repo'].join('\n'),
      { maxLines: 4 },
    );
    expect(lines).toContain('Files referenced: /workspace/app/foo.ts');
  });

  it('repairs consecutive users without merging into the seed task', () => {
    const messages = [
      msg('seed', 'user', 'Task'),
      msg('checkpoint', 'user', 'Guidance'),
      msg('tool', 'user', 'payload', { isToolResult: true }),
      msg('assistant', 'assistant', 'continue'),
    ];

    normalizeTrimmedRoleAlternation(messages, 7, () => 123);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[0].content).toBe('Task');
    expect(messages[1].id).toBe('coder-context-bridge-7-0');
    expect(messages.some((message) => message.isToolResult)).toBe(false);
  });
});
