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
});
