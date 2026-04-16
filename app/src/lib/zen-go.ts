export type ZenGoTransport = 'openai' | 'anthropic';

const ZEN_GO_ANTHROPIC_MODELS = new Set(['minimax-m2.5', 'minimax-m2.7']);

export const ZEN_GO_MODELS = [
  'glm-5.1',
  'kimi-k2.5',
  'glm-5',
  'mimo-v2-pro',
  'mimo-v2-omni',
  'qwen3.6-plus',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.5-plus',
] as const;

export function getZenGoTransport(model: string | null | undefined): ZenGoTransport {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return ZEN_GO_ANTHROPIC_MODELS.has(normalized) ? 'anthropic' : 'openai';
}
