export type ZenGoTransport = 'openai' | 'anthropic';

const ZEN_GO_ANTHROPIC_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
]);

export const ZEN_GO_MODELS = [
  'kimi-k2.5',
  'glm-5',
  'minimax-m2.7',
  'minimax-m2.5',
] as const;

export function getZenGoTransport(model: string | null | undefined): ZenGoTransport {
  const normalized = typeof model === 'string' ? model.trim() : '';
  return ZEN_GO_ANTHROPIC_MODELS.has(normalized) ? 'anthropic' : 'openai';
}
