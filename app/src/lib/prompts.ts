import type { PRData, AnalysisResult } from '@/types';

export const ANALYSIS_PROMPT = `You are a code review assistant. Analyze this PR diff and provide structured feedback.

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

export function buildPrompt(prData: PRData): string {
  return ANALYSIS_PROMPT
    .replace('{{TITLE}}', prData.title)
    .replace('{{AUTHOR}}', prData.author)
    .replace('{{ADDITIONS}}', String(prData.additions))
    .replace('{{DELETIONS}}', String(prData.deletions))
    .replace('{{FILES_COUNT}}', String(prData.changedFiles))
    .replace('{{DIFF}}', prData.diff.substring(0, 10000));
}

export const MOCK_ANALYSIS: AnalysisResult = {
  summary:
    'This PR refactors the authentication middleware to use JWT tokens instead of session cookies. It also updates the user model to include token expiration handling.',
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
