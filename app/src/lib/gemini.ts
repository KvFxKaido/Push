import type { PRData, AnalysisResult } from '@/types';
import { MOCK_ANALYSIS, buildPrompt } from '@/lib/prompts';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

export async function analyzePRWithGemini(prData: PRData): Promise<AnalysisResult> {
  // If no API key, return mock data for demo
  if (!GEMINI_API_KEY) {
    console.log('No Gemini API key found, returning mock analysis');
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    return MOCK_ANALYSIS;
  }

  const prompt = buildPrompt(prData);

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as AnalysisResult;
    }

    throw new Error('Could not parse Gemini response');
  } catch (error) {
    console.error('Gemini analysis failed:', error);
    // Fallback to mock on error
    return MOCK_ANALYSIS;
  }
}

export { MOCK_ANALYSIS };
