import { describe, expect, it } from 'vitest';
import type { LlmContentPart } from '@push/lib/provider-contract';
import { toCoderJobPayloadMessages } from './coder-job-stream-adapter';

describe('toCoderJobPayloadMessages (#937)', () => {
  it('forwards multipart contentParts so background attachments are not dropped', () => {
    const contentParts: LlmContentPart[] = [
      { type: 'text', text: 'Task: describe this screenshot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ];
    const out = toCoderJobPayloadMessages([
      { role: 'user', content: 'Task: describe this screenshot', contentParts },
    ]);
    expect(out).toEqual([{ role: 'user', content: contentParts }]);
  });

  it('keeps plain turns as string content', () => {
    const out = toCoderJobPayloadMessages([
      { role: 'system', content: 'you are a coder' },
      { role: 'user', content: 'hello' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'you are a coder' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('treats an empty contentParts array as a plain text turn', () => {
    const out = toCoderJobPayloadMessages([{ role: 'user', content: 'hi', contentParts: [] }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('coerces missing content to an empty string', () => {
    const out = toCoderJobPayloadMessages([{ role: 'assistant' }]);
    expect(out).toEqual([{ role: 'assistant', content: '' }]);
  });
});
