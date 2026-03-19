export function shouldAutoFetchProviderModels(params: {
  hasKey: boolean;
  modelCount: number;
  loading: boolean;
  error: string | null;
}): boolean {
  return params.hasKey && params.modelCount === 0 && !params.loading && !params.error;
}
