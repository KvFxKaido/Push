import type { PRData, AnalysisResult } from '@/types';
import { MOCK_ANALYSIS, buildPrompt } from '@/lib/prompts';

// Dev only — production uses the Worker proxy
const OLLAMA_CLOUD_API_KEY = import.meta.env.VITE_OLLAMA_CLOUD_API_KEY || '';

if (!import.meta.env.DEV && OLLAMA_CLOUD_API_KEY) {
  console.warn('[Diff] OLLAMA_CLOUD_API_KEY should not be set in production builds — use the Cloudflare Worker proxy instead.');
}

// Dev: Vite proxy avoids CORS. Prod: Vercel Edge function at /api/chat holds the key.
const OLLAMA_CLOUD_API_URL =
  import.meta.env.VITE_OLLAMA_CLOUD_API_URL ||
  (import.meta.env.DEV ? '/ollama/api/chat' : '/api/chat');

const isDemoMode = import.meta.env.DEV && !OLLAMA_CLOUD_API_KEY;

export async function analyzePRWithOllamaCloud(
  prData: PRData,
  model = 'gemini-3-pro-preview:latest',
): Promise<AnalysisResult> {
  if (isDemoMode) {
    console.log('[Diff] Demo mode — returning mock analysis');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { ...MOCK_ANALYSIS, _demo: true } as AnalysisResult;
  }

  const prompt = buildPrompt(prData);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (OLLAMA_CLOUD_API_KEY) {
    headers['Authorization'] = `Bearer ${OLLAMA_CLOUD_API_KEY}`;
  }

  const response = await fetch(OLLAMA_CLOUD_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a code review assistant. Respond only with valid JSON, no commentary.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama Cloud API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  // Native Ollama format: { message: { role, content }, done: true }
  const text = data.message?.content || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]) as AnalysisResult;
  }

  throw new Error('Could not parse Ollama Cloud response as JSON');
}
