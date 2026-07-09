import { describe, expect, it } from 'vitest';
import {
  buildModelCapabilityAwarenessBlock,
  getModelCapabilities,
  getVisionCapabilityNotice,
} from './model-capabilities';

describe('getModelCapabilities', () => {
  it('marks Claude OpenRouter models as vision-capable', () => {
    expect(
      getModelCapabilities('openrouter', 'anthropic/claude-sonnet-4.6:nitro').visionInput,
    ).toBe('supported');
  });

  it('marks Imagen-family models as image-generation capable', () => {
    const capabilities = getModelCapabilities('google', 'imagen-4');
    expect(capabilities.imageGeneration).toBe('supported');
    expect(capabilities.visionInput).toBe('supported');
  });

  it('leaves unknown models in the unknown state', () => {
    expect(getModelCapabilities('zen', 'totally-unknown-model').visionInput).toBe('unknown');
  });

  it('uses declared metadata before regex capability fallbacks', () => {
    const mini = getModelCapabilities('openai', 'gpt-5.4-mini');
    expect(mini.visionInput).toBe('supported');
    expect(mini.toolCalls).toBe('supported');
    expect(mini.jsonMode).toBe('supported');

    const deepseek = getModelCapabilities('deepseek', 'deepseek-v4-pro');
    expect(deepseek.visionInput).toBe('unsupported');
    expect(deepseek.toolCalls).toBe('supported');
    expect(deepseek.jsonMode).toBe('supported');
  });

  it('does not mark PDF-only declared models as vision-capable', () => {
    // codestral-2508 accepts text + PDF but no image input; PDF/file attachment
    // support must not be reported as image vision.
    expect(getModelCapabilities('openrouter', 'mistralai/codestral-2508').visionInput).toBe(
      'unsupported',
    );
  });

  it('treats demo as unsupported for image input', () => {
    expect(getVisionCapabilityNotice('demo', 'demo').support).toBe('unsupported');
  });
});

describe('buildModelCapabilityAwarenessBlock', () => {
  it('describes supported image inspection and delegation inheritance', () => {
    const block = buildModelCapabilityAwarenessBlock(
      'openrouter',
      'anthropic/claude-sonnet-4.6:nitro',
      { hasImageAttachments: true },
    );

    expect(block).toContain('Provider: OpenRouter');
    expect(block).toContain('Model: anthropic/claude-sonnet-4.6:nitro');
    expect(block).toContain('Vision / image attachments: supported');
    expect(block).toContain(
      'Delegated Coder and Explorer runs inherit this same chat-locked provider/model by default.',
    );
    expect(block).toContain(
      'current conversation includes image attachments, and this model can inspect them',
    );
    expect(block).toContain('Push tool use is prompt-engineered.');
  });

  it('flags unsupported image inspection explicitly', () => {
    const block = buildModelCapabilityAwarenessBlock('demo', 'demo', { hasImageAttachments: true });

    expect(block).toContain('Vision / image attachments: unsupported');
    expect(block).toContain('this model cannot inspect them');
  });

  it('marks unknown image support as unverified', () => {
    const block = buildModelCapabilityAwarenessBlock('zen', 'totally-unknown-model', {
      hasImageAttachments: true,
    });

    expect(block).toContain('Vision / image attachments: unverified');
    expect(block).toContain('support is unverified');
    expect(block).toContain('Image generation: unverified');
  });

  it('formats Kilo Code with a human-readable provider label', () => {
    const block = buildModelCapabilityAwarenessBlock('kilocode', 'google/gemini-3-flash-preview', {
      hasImageAttachments: true,
    });

    expect(block).toContain('Provider: Kilo Code');
  });

  it('formats Fireworks AI with a human-readable provider label', () => {
    const block = buildModelCapabilityAwarenessBlock(
      'fireworks',
      'accounts/fireworks/models/deepseek-v4-pro',
      {
        hasImageAttachments: true,
      },
    );

    expect(block).toContain('Provider: Fireworks AI');
  });
});
