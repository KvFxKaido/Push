import { describe, expect, it } from 'vitest';

import type { LlmMessage } from './provider-contract.ts';
import { deriveContentBlocks, withContentBlocks } from './content-blocks.ts';

const msg = (extra: Partial<LlmMessage>): LlmMessage => ({
  id: '1',
  role: 'user',
  content: '',
  timestamp: 0,
  ...extra,
});

describe('deriveContentBlocks', () => {
  it('wraps a plain string content as a single text block', () => {
    expect(deriveContentBlocks(msg({ content: 'hello' }))).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('maps contentParts (text + data/url images) to text/image blocks', () => {
    expect(
      deriveContentBlocks(
        msg({
          content: 'fallback',
          contentParts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
    ]);
  });

  it('prepends signed reasoning blocks (Anthropic ordering) and carries cache_control', () => {
    expect(
      deriveContentBlocks(
        msg({
          role: 'assistant',
          reasoningBlocks: [{ type: 'thinking', text: 'hmm', signature: 's' }],
          contentParts: [{ type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } }],
        }),
      ),
    ).toEqual([
      { type: 'thinking', text: 'hmm', signature: 's' },
      { type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('returns [] for an empty turn', () => {
    expect(deriveContentBlocks(msg({ content: '' }))).toEqual([]);
  });

  it('throws on a malformed image part (missing url) and an unrepresentable url', () => {
    expect(() =>
      deriveContentBlocks(
        msg({ contentParts: [{ type: 'image_url', image_url: {} }] as LlmMessage['contentParts'] }),
      ),
    ).toThrow(/unsupported or malformed content part/);
    expect(() =>
      deriveContentBlocks(
        msg({ contentParts: [{ type: 'image_url', image_url: { url: 'ftp://x/y.png' } }] }),
      ),
    ).toThrow(/unsupported or malformed content part/);
  });
});

describe('withContentBlocks', () => {
  it('materializes contentBlocks for a multimodal (contentParts) turn', () => {
    const out = withContentBlocks(msg({ contentParts: [{ type: 'text', text: 'hi' }] }));
    expect(out.contentBlocks).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('leaves a plain-text turn untouched (no contentBlocks added)', () => {
    const input = msg({ content: 'just text' });
    expect(withContentBlocks(input)).toBe(input);
  });

  it('leaves a reasoning-only turn (no contentParts) untouched — stays byte-identical via the sidecar', () => {
    const input = msg({
      role: 'assistant',
      content: 'because',
      reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
    });
    expect(withContentBlocks(input).contentBlocks).toBeUndefined();
  });

  it('is idempotent when contentBlocks already present', () => {
    const input = msg({ contentBlocks: [{ type: 'text', text: 'pre' }] });
    expect(withContentBlocks(input)).toBe(input);
  });
});
