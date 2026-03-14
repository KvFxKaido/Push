import { describe, expect, it } from 'vitest';
import { getModelCapabilities, getVisionCapabilityNotice } from './model-capabilities';

describe('getModelCapabilities', () => {
  it('marks Claude OpenRouter models as vision-capable', () => {
    expect(getModelCapabilities('openrouter', 'anthropic/claude-sonnet-4.6:nitro').visionInput).toBe('supported');
  });

  it('marks Imagen-family models as image-generation capable', () => {
    const capabilities = getModelCapabilities('vertex', 'google/imagen-4');
    expect(capabilities.imageGeneration).toBe('supported');
    expect(capabilities.visionInput).toBe('supported');
  });

  it('leaves unknown models in the unknown state', () => {
    expect(getModelCapabilities('zen', 'big-pickle').visionInput).toBe('unknown');
  });

  it('treats demo as unsupported for image input', () => {
    expect(getVisionCapabilityNotice('demo', 'demo').support).toBe('unsupported');
  });
});
