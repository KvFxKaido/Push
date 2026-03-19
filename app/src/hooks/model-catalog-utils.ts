// OpenCode's current Zen Go docs route MiniMax Go models through an Anthropic-style
// `/messages` endpoint, while Push's Zen integration is OpenAI-compatible only.
const PUSH_UNSUPPORTED_ZEN_GO_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
]);

export function shouldAutoFetchProviderModels(params: {
  hasKey: boolean;
  modelCount: number;
  loading: boolean;
  error: string | null;
}): boolean {
  return params.hasKey && params.modelCount === 0 && !params.loading && !params.error;
}

export function filterPushSupportedZenGoModels(models: string[]): string[] {
  return models.filter((model) => !PUSH_UNSUPPORTED_ZEN_GO_MODELS.has(model));
}

export function isPushSupportedZenGoModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return !PUSH_UNSUPPORTED_ZEN_GO_MODELS.has(model.trim());
}
