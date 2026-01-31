import { useState, useCallback } from 'react';
import type { PRData, AnalysisResult, AIProviderType } from '@/types';
import { analyzePR } from '@/lib/providers';

export function useAnalysis() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const runAnalysis = useCallback(
    async (
      prData: PRData,
      providerType: AIProviderType = 'gemini',
      modelId?: string,
    ): Promise<AnalysisResult | null> => {
      setLoading(true);
      setError(null);

      try {
        // Simulate progress for UX
        await new Promise((resolve) => setTimeout(resolve, 500));

        const analysis = await analyzePR(prData, providerType, modelId);

        setResult(analysis);
        return analysis;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { runAnalysis, reset, result, loading, error };
}
