import { describe, expect, it, vi } from 'vitest';
import {
  resolvePushCapabilityProfile,
  type PushCapabilityMetadataLookup,
  type PushModelCapabilityMetadata,
} from './capability-profile.js';

function lookup(metadata: PushModelCapabilityMetadata): PushCapabilityMetadataLookup {
  return () => metadata;
}

describe('resolvePushCapabilityProfile', () => {
  it('does not consult surface metadata without a selected model', () => {
    const lookupMetadata = vi.fn<PushCapabilityMetadataLookup>();
    expect(resolvePushCapabilityProfile('anthropic', undefined, lookupMetadata)).toMatchObject({
      toolCalling: 'none',
      streamingTools: false,
      contentBlocks: true,
      reasoningBlocks: false,
      context: 'small',
    });
    expect(lookupMetadata).not.toHaveBeenCalled();
  });

  it('uses the same metadata decision for capability-backed providers', () => {
    expect(
      resolvePushCapabilityProfile('openrouter', 'vendor/tool-model', lookup({ toolCall: true })),
    ).toMatchObject({ toolCalling: 'native', streamingTools: true });
    expect(
      resolvePushCapabilityProfile('openrouter', 'vendor/text-model', lookup({ toolCall: false })),
    ).toMatchObject({ toolCalling: 'json-text', streamingTools: false });
  });

  it('accepts curated evidence from a surface without duplicating its catalog', () => {
    expect(
      resolvePushCapabilityProfile('anthropic', 'claude-sonnet-4-6', lookup({ toolCall: true })),
    ).toMatchObject({ toolCalling: 'native', structuredOutput: 'strict' });
    expect(
      resolvePushCapabilityProfile('anthropic', 'claude-unknown', lookup({ toolCall: false })),
    ).toMatchObject({ toolCalling: 'json-text', structuredOutput: 'best-effort' });
    expect(
      resolvePushCapabilityProfile('deepseek', 'deepseek-model', lookup({ toolCall: true })),
    ).toMatchObject({ toolCalling: 'json-text' });
  });

  it('uses Cloudflare name fallback only when the surface has no catalog evidence', () => {
    const model = '@cf/moonshotai/kimi-k2.7-code';
    expect(resolvePushCapabilityProfile('cloudflare', model, lookup({}))).toMatchObject({
      toolCalling: 'native',
      structuredOutput: 'strict',
    });
    expect(
      resolvePushCapabilityProfile(
        'cloudflare',
        model,
        lookup({ toolCall: false, structuredOutput: false }),
      ),
    ).toMatchObject({ toolCalling: 'json-text', structuredOutput: 'none' });
  });

  it('resolves route wire, reasoning replay, multimodal, and context coherently', () => {
    expect(
      resolvePushCapabilityProfile(
        'zen',
        'minimax-m3',
        lookup({ vision: true, contextLimit: 512_000 }),
        { requestWire: 'neutral' },
      ),
    ).toMatchObject({
      contentBlocks: true,
      reasoningBlocks: true,
      multimodal: true,
      structuredOutput: 'best-effort',
      context: 'large',
    });
    expect(
      resolvePushCapabilityProfile('zen', 'kimi-k2.6', lookup({ contextLimit: 32_000 }), {
        requestWire: 'openai',
      }),
    ).toMatchObject({
      contentBlocks: false,
      reasoningBlocks: false,
      context: 'small',
    });
  });
});
