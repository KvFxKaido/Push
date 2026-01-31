import type { PRData, AnalysisResult } from '@/types';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// HARDCODED PROMPT - Scoped and focused
const ANALYSIS_PROMPT = `You are a code review assistant. Analyze this PR diff and provide structured feedback.

Rules:
- Be concise and factual
- Flag actual risks, not style preferences
- Distinguish logical changes from mechanical refactors
- Do not ask questions or suggest features
- Do not engage conversationally

Output JSON only with this structure:
{
  "summary": "2-3 sentence overview of what this PR does",
  "risks": [
    {"level": "low|medium|high", "category": "category name", "description": "brief risk description"}
  ],
  "diffNotes": [
    {"file": "filename", "type": "logic|mechanical|style", "note": "brief note"}
  ],
  "hotspots": [
    {"file": "filename", "reason": "why this file needs attention", "complexity": 1-10}
  ]
}

PR Title: {{TITLE}}
Author: {{AUTHOR}}
Additions: {{ADDITIONS}}
Deletions: {{DELETIONS}}
Files Changed: {{FILES_COUNT}}

Diff:
{{DIFF}}
`;

// Mock analysis for demo/development
const MOCK_ANALYSIS: AnalysisResult = {
  summary: 'This PR refactors the authentication middleware to use JWT tokens instead of session cookies. It also updates the user model to include token expiration handling.',
  risks: [
    {
      level: 'high',
      category: 'Security',
      description: 'Token secret is read from env but no validation that it exists',
    },
    {
      level: 'medium',
      category: 'Breaking Change',
      description: 'Session cookie removal may break existing client integrations',
    },
    {
      level: 'low',
      category: 'Testing',
      description: 'New token expiration paths lack test coverage',
    },
  ],
  diffNotes: [
    {
      file: 'src/auth/middleware.ts',
      type: 'logic',
      note: 'JWT verification logic added - check algorithm is explicitly set',
    },
    {
      file: 'src/models/user.ts',
      type: 'mechanical',
      note: 'Field renaming from sessionId to tokenId - migration needed',
    },
    {
      file: 'src/routes/login.ts',
      type: 'style',
      note: 'Console.log statements should be removed',
    },
  ],
  hotspots: [
    {
      file: 'src/auth/middleware.ts',
      reason: 'Core auth logic changed, security critical',
      complexity: 8,
    },
    {
      file: 'src/models/user.ts',
      reason: 'Database schema changes affect all user operations',
      complexity: 6,
    },
  ],
};

export async function analyzePRWithGemini(prData: PRData): Promise<AnalysisResult> {
  // If no API key, return mock data for demo
  if (!GEMINI_API_KEY) {
    console.log('No Gemini API key found, returning mock analysis');
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    return MOCK_ANALYSIS;
  }

  const prompt = ANALYSIS_PROMPT
    .replace('{{TITLE}}', prData.title)
    .replace('{{AUTHOR}}', prData.author)
    .replace('{{ADDITIONS}}', String(prData.additions))
    .replace('{{DELETIONS}}', String(prData.deletions))
    .replace('{{FILES_COUNT}}', String(prData.changedFiles))
    .replace('{{DIFF}}', prData.diff.substring(0, 10000)); // Limit diff size

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
