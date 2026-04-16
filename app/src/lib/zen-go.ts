export type ZenGoTransport = 'openai' | 'anthropic';

const ZEN_GO_ANTHROPIC_MODELS = new Set(['minimax-m2.5', 'minimax-m2.7']);

export const ZEN_GO_MODELS = [
  'glm-5',
  'glm-5.1',
  'kimi-k2.5',
  'mimo-v2-omni',
  'mimo-v2-pro',
  'minimax-m2.5',
  'minimax-m2.7',
  'qwen3.5-plus',
  'qwen3.6-plus',
] as const;

export const ZEN_GO_DEFAULT_MODEL: (typeof ZEN_GO_MODELS)[number] = 'glm-5.1';

export function getZenGoTransport(model: string | null | undefined): ZenGoTransport {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return ZEN_GO_ANTHROPIC_MODELS.has(normalized) ? 'anthropic' : 'openai';
}
