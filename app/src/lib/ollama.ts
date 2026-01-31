import type { PRData, AnalysisResult } from '@/types';
import { MOCK_ANALYSIS, buildPrompt } from '@/lib/prompts';

const OLLAMA_CLOUD_API_KEY = import.meta.env.VITE_OLLAMA_CLOUD_API_KEY || '';
const OLLAMA_CLOUD_API_URL =
  import.meta.env.VITE_OLLAMA_CLOUD_API_URL || 'https://api.ollama.com/v1/chat/completions';

export async function analyzePRWithOllamaCloud(
  prData: PRData,
  model = 'gemini3:latest',
): Promise<AnalysisResult> {
  if (!OLLAMA_CLOUD_API_KEY) {
    console.log('No Ollama Cloud API key found, returning mock analysis');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return MOCK_ANALYSIS;
  }

  const prompt = buildPrompt(prData);

  try {
    const response = await fetch(OLLAMA_CLOUD_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OLLAMA_CLOUD_API_KEY}`,
      },
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
        temperature: 0.1,
        max_tokens: 2048,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama Cloud API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as AnalysisResult;
    }

    throw new Error('Could not parse Ollama Cloud response');
  } catch (error) {
    console.error('Ollama Cloud analysis failed:', error);
    return MOCK_ANALYSIS;
  }
}
