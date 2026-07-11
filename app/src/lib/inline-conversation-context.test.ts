import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/types';
import { buildInlineConversationSeed } from './inline-conversation-context';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    ...overrides,
  };
}

describe('buildInlineConversationSeed', () => {
  it('builds contentBlocks from user attachments', () => {
    const [seed] = buildInlineConversationSeed([
      msg({
        content: 'see image',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            filename: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            content: 'data:image/png;base64,AAA',
          },
        ],
      }),
    ]);

    expect(seed.contentBlocks).toEqual([
      { type: 'text', text: 'see image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
    expect(seed.contentParts).toBeUndefined();
  });

  it('preserves explicit contentParts instead of rebuilding attachments', () => {
    const contentParts = [
      { type: 'text' as const, text: 'explicit' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,OLD' } },
    ];
    const [seed] = buildInlineConversationSeed([
      msg({
        content: 'see image',
        contentParts,
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            filename: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            content: 'ftp://example.com/ignored.png',
          },
        ],
      }),
    ]);

    expect(seed.contentParts).toEqual(contentParts);
    expect(seed.contentBlocks).toBeUndefined();
  });

  // Regression: an assistant turn whose whole answer stayed on the reasoning
  // channel (content '', thinking carrying the reply the user read) seeded an
  // empty-content message that the wire builder (`toLLMMessages`) drops — the
  // turn the user was replying to never reached the model again.
  it('promotes stranded reasoning to content for content-empty assistant turns', () => {
    const [seed] = buildInlineConversationSeed([
      msg({
        role: 'assistant',
        content: '',
        thinking: 'I can check the recent commits for you.',
      }),
    ]);
    expect(seed.content).toBe('I can check the recent commits for you.');
  });

  it('keeps real content and leaves signed-reasoning turns untouched', () => {
    const [withContent] = buildInlineConversationSeed([
      msg({ role: 'assistant', content: 'Real answer.', thinking: 'deliberation' }),
    ]);
    expect(withContent.content).toBe('Real answer.');

    const reasoningBlocks = [{ type: 'thinking' as const, text: 'signed', signature: 'sig' }];
    const [signed] = buildInlineConversationSeed([
      msg({ role: 'assistant', content: '', thinking: 'signed', reasoningBlocks }),
    ]);
    expect(signed.content).toBe('');
    expect(signed.reasoningBlocks).toEqual(reasoningBlocks);
  });

  // Codex P2 (#1420): a native function-call round can persist an assistant
  // turn with empty content, private reasoning, and the call in sidecars.
  // That reasoning must not be promoted into a user-visible assistant reply.
  it('does not promote reasoning for tool-call turns', () => {
    const [flagged] = buildInlineConversationSeed([
      msg({ role: 'assistant', content: '', thinking: 'private deliberation', isToolCall: true }),
    ]);
    expect(flagged.content).toBe('');

    const [nativeCall] = buildInlineConversationSeed([
      msg({
        role: 'assistant',
        content: '',
        thinking: 'private deliberation',
        toolUses: [{ type: 'tool_use', id: 'tu_1', name: 'repo_ls', input: {} }],
      }),
    ]);
    expect(nativeCall.content).toBe('');
  });
});
