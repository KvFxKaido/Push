import { describe, expect, it } from 'vitest';

import { strandedReasoningAnswerText, stripToolCallPayload } from './message-content';

describe('stripToolCallPayload', () => {
  it('strips braced tool JSON while preserving preceding prose', () => {
    expect(stripToolCallPayload('Before\n{"tool":"sandbox_exec","args":{"command":"ls"}}')).toBe(
      'Before',
    );
  });

  it('strips brace-less quoted tool JSON while preserving preceding prose', () => {
    expect(
      stripToolCallPayload('Before\n"tool": "list_commits", "args": {"repo": "a/b", "count": 10}}'),
    ).toBe('Before');
  });

  it('leaves schema-like prose untouched when args are not object-shaped', () => {
    expect(stripToolCallPayload('tool: read_file, args: path=README.md')).toBe(
      'tool: read_file, args: path=README.md',
    );
    expect(stripToolCallPayload('Config:\ntool: "read_file", args: path=README.md')).toBe(
      'Config:\ntool: "read_file", args: path=README.md',
    );
  });

  it('strips truncated brace-less quoted tool payloads once args start as an object', () => {
    expect(stripToolCallPayload('Before\n"tool": "sandbox_exec", "args": {')).toBe('Before');
  });

  it('strips array-wrapped tool calls leaving no bracket artifacts', () => {
    expect(
      stripToolCallPayload('[\n  {"tool":"sandbox_read_file","args":{"path":"src/main.ts"}}\n]'),
    ).toBe('');
  });

  it('strips array-wrapped tool calls with preceding prose', () => {
    expect(
      stripToolCallPayload(
        'Let me read that.\n[\n  {"tool":"sandbox_read_file","args":{"path":"src/main.ts"}}\n]',
      ),
    ).toBe('Let me read that.');
  });

  it('strips lone bracket/brace artifacts like [\\n  {\\n]', () => {
    expect(stripToolCallPayload('[\n  {\n]')).toBe('');
    expect(stripToolCallPayload('[  ]')).toBe('');
    expect(stripToolCallPayload('[\n{\n}\n]')).toBe('');
    expect(stripToolCallPayload('[,]')).toBe('');
  });

  it('strips multiple array-wrapped tool calls', () => {
    const content = [
      '[',
      '  {"tool":"sandbox_read_file","args":{"path":"a.ts"}},',
      '  {"tool":"sandbox_read_file","args":{"path":"b.ts"}}',
      ']',
    ].join('\n');
    expect(stripToolCallPayload(content)).toBe('');
  });

  it('strips native tool-call echo fragment (no "tool" key)', () => {
    expect(stripToolCallPayload('repo_ls", "repo": "KvFxKaido/Push"}}')).toBe('');
  });

  it('strips native echo with args object', () => {
    expect(
      stripToolCallPayload(
        'repo_read", "args": {"repo": "KvFxKaido/Push", "path": "README.md", "start_line": 1, "end_line": 400}}',
      ),
    ).toBe('');
  });

  it('strips native echo preserving preceding prose', () => {
    expect(
      stripToolCallPayload('Let me check.\nrepo_ls", "args": {"repo": "KvFxKaido/Push"}}'),
    ).toBe('Let me check.');
  });

  it('strips orphaned JSON tail from shell command', () => {
    const leaked =
      'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json","workdir":"/workspace"}}';
    expect(stripToolCallPayload(leaked)).toBe(
      'workspace/app && npm audit fix && npx vitest run src/lib/orchestrator.test.ts && npm audit --json',
    );
  });

  it('strips native echo with fenced tool call JSON alongside', () => {
    const content =
      'repo_read", "args": {"repo": "a/b", "path": "AGENTS.md"}}\n```json\n{"tool":"repo_read","args":{"repo":"a/b","path":"AGENTS.md"}}\n```';
    expect(stripToolCallPayload(content)).toBe('');
  });

  it('strips DeepSeek DSML tool-call blocks while preserving preceding prose', () => {
    const content = [
      "Let me pull up the open issues so I can give you a real read on what's ripe.",
      '',
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="issue">',
      '<｜｜DSML｜｜parameter name="repo" string="true">KvFxKaido/Push</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="issue_number" string="true">1260</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');
    expect(stripToolCallPayload(content)).toBe(
      "Let me pull up the open issues so I can give you a real read on what's ripe.",
    );
  });
});

describe('strandedReasoningAnswerText', () => {
  const stranded = (extra: Record<string, unknown> = {}) => ({
    role: 'assistant' as const,
    content: '',
    thinking: 'The user wants recent changes. I can list the latest commits for them.',
    ...extra,
  });

  it('salvages the reasoning of a content-empty assistant turn', () => {
    expect(strandedReasoningAnswerText(stranded())).toBe(
      'The user wants recent changes. I can list the latest commits for them.',
    );
  });

  it('returns null when content is already present', () => {
    expect(strandedReasoningAnswerText(stranded({ content: 'Real answer.' }))).toBeNull();
    expect(strandedReasoningAnswerText(stranded({ displayContent: 'Rendered.' }))).toBeNull();
  });

  it('returns null for user messages and for turns without reasoning', () => {
    expect(strandedReasoningAnswerText({ role: 'user', content: '', thinking: 'x' })).toBeNull();
    expect(strandedReasoningAnswerText(stranded({ thinking: undefined }))).toBeNull();
    expect(strandedReasoningAnswerText(stranded({ thinking: '   ' }))).toBeNull();
  });

  it('returns null when signed reasoningBlocks own the replay contract', () => {
    expect(
      strandedReasoningAnswerText(stranded({ reasoningBlocks: [{ type: 'thinking' }] })),
    ).toBeNull();
  });

  it('returns null when an encrypted Responses item owns the replay contract', () => {
    expect(
      strandedReasoningAnswerText(
        stranded({
          responsesReasoningItems: [
            { type: 'reasoning', encrypted_content: 'provider-ciphertext' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('returns null for tool-call turns — flagged or carrying a native toolUses sidecar', () => {
    expect(strandedReasoningAnswerText(stranded({ isToolCall: true }))).toBeNull();
    expect(
      strandedReasoningAnswerText(
        stranded({ toolUses: [{ type: 'tool_use', id: 'tu_1', name: 'repo_ls', input: {} }] }),
      ),
    ).toBeNull();
  });

  it('strips buried tool-call payloads and returns null when nothing else remains', () => {
    expect(
      strandedReasoningAnswerText(
        stranded({
          thinking: 'I should check the log.\n{"tool":"sandbox_exec","args":{"command":"git log"}}',
        }),
      ),
    ).toBe('I should check the log.');
    expect(
      strandedReasoningAnswerText(
        stranded({ thinking: '{"tool":"sandbox_exec","args":{"command":"git log"}}' }),
      ),
    ).toBeNull();
  });
});
