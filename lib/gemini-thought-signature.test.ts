import { describe, expect, it } from 'vitest';

import {
  GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
  isGeminiModelId,
  readToolCallThoughtSignature,
  resolveGeminiReplaySignature,
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

describe('isGeminiModelId', () => {
  it('matches bare and namespaced Gemini ids', () => {
    expect(isGeminiModelId('gemini-3-flash')).toBe(true);
    expect(isGeminiModelId('gemini-3-pro-preview')).toBe(true);
    expect(isGeminiModelId('google/gemini-3-pro')).toBe(true);
    expect(isGeminiModelId('GEMINI-3-FLASH')).toBe(true);
  });

  it('does not match non-Gemini ids or non-strings', () => {
    expect(isGeminiModelId('gpt-5')).toBe(false);
    expect(isGeminiModelId('deepseek-reasoner')).toBe(false);
    expect(isGeminiModelId('claude-opus-4-8')).toBe(false);
    expect(isGeminiModelId(undefined)).toBe(false);
    expect(isGeminiModelId('')).toBe(false);
  });
});

describe('resolveGeminiReplaySignature', () => {
  it('prefers a real captured signature over the placeholder', () => {
    expect(resolveGeminiReplaySignature({ ownSignature: 'real', isFirstCallInTurn: true })).toBe(
      'real',
    );
    // A real signature on a non-first call still wins (never overridden/dropped).
    expect(resolveGeminiReplaySignature({ ownSignature: 'real', isFirstCallInTurn: false })).toBe(
      'real',
    );
  });

  it('substitutes the placeholder only for the turn-first signatureless call', () => {
    expect(resolveGeminiReplaySignature({ ownSignature: undefined, isFirstCallInTurn: true })).toBe(
      GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
    );
  });

  it('leaves a trailing signatureless parallel call bare', () => {
    expect(
      resolveGeminiReplaySignature({ ownSignature: undefined, isFirstCallInTurn: false }),
    ).toBeUndefined();
  });
});
