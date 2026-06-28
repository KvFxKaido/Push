import { describe, expect, it } from 'vitest';

import {
  readToolCallThoughtSignature,
  toolCallThoughtSignatureFields,
} from './gemini-thought-signature.ts';

describe('readToolCallThoughtSignature', () => {
  it('reads the top-level sibling shape', () => {
    expect(readToolCallThoughtSignature({ thoughtSignature: 'sig' })).toBe('sig');
  });

  it("reads Google's extra_content envelope shape", () => {
    expect(
      readToolCallThoughtSignature({ extra_content: { google: { thought_signature: 'sig' } } }),
    ).toBe('sig');
  });

  it('prefers the top-level sibling when both are present', () => {
    expect(
      readToolCallThoughtSignature({
        thoughtSignature: 'top',
        extra_content: { google: { thought_signature: 'nested' } },
      }),
    ).toBe('top');
  });

  it('returns undefined when neither shape carries a non-empty string', () => {
    expect(readToolCallThoughtSignature({})).toBeUndefined();
    expect(readToolCallThoughtSignature({ thoughtSignature: '' })).toBeUndefined();
    expect(
      readToolCallThoughtSignature({ extra_content: { google: { thought_signature: '' } } }),
    ).toBeUndefined();
    expect(readToolCallThoughtSignature({ thoughtSignature: 42 })).toBeUndefined();
    expect(readToolCallThoughtSignature({ extra_content: { google: {} } })).toBeUndefined();
    expect(readToolCallThoughtSignature({ extra_content: {} })).toBeUndefined();
  });
});

describe('toolCallThoughtSignatureFields', () => {
  it('emits both wire shapes when a signature is present', () => {
    expect(toolCallThoughtSignatureFields('sig')).toEqual({
      thoughtSignature: 'sig',
      extra_content: { google: { thought_signature: 'sig' } },
    });
  });

  it('emits nothing when the signature is absent', () => {
    expect(toolCallThoughtSignatureFields(undefined)).toEqual({});
    expect(toolCallThoughtSignatureFields('')).toEqual({});
  });
});
