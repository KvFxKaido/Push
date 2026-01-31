import { useState, useCallback } from 'react';
import type { PRInput, PRData, PRFile } from '@/types';

const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

// Mock PR data for demo when API fails or no token
const MOCK_PR_DATA: PRData = {
  title: 'Refactor: Migrate auth from session cookies to JWT tokens',
  author: 'demo-user',
  additions: 156,
  deletions: 89,
  changedFiles: 4,
  diff: `diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
+ import jwt from 'jsonwebtoken';
+ const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);
- const session = req.cookies.sessionId;
+ const token = req.headers.authorization?.split(' ')[1];`,
  files: [
    { filename: 'src/auth/middleware.ts', status: 'modified', additions: 45, deletions: 23 },
    { filename: 'src/models/user.ts', status: 'modified', additions: 34, deletions: 12 },
    { filename: 'src/routes/login.ts', status: 'modified', additions: 56, deletions: 34 },
    { filename: 'src/utils/token.ts', status: 'added', additions: 21, deletions: 0 },
  ],
};

export function useGitHub() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPRData = useCallback(async (input: PRInput): Promise<PRData | null> => {
    setLoading(true);
    setError(null);

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
      };
      if (GITHUB_TOKEN) {
        headers['Authorization'] = `token ${GITHUB_TOKEN}`;
      }

      // Fetch PR details
      const prResponse = await fetch(
        `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`,
        { headers }
      );

      if (!prResponse.ok) {
        throw new Error(`PR not found: ${prResponse.status}`);
      }

      const prData = await prResponse.json();

      // Fetch PR files
      const filesResponse = await fetch(
        `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/files`,
        { headers }
      );

      if (!filesResponse.ok) {
        throw new Error(`Could not fetch files: ${filesResponse.status}`);
      }

      const filesData = await filesResponse.json();

      // Fetch diff
      const diffResponse = await fetch(
        `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`,
        {
          headers: {
            ...headers,
            'Accept': 'application/vnd.github.v3.diff',
          },
        }
      );

      let diff = '';
      if (diffResponse.ok) {
        diff = await diffResponse.text();
      }

      const files: PRFile[] = filesData.map((f: any) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }));

      return {
        title: prData.title,
        author: prData.user.login,
        additions: prData.additions,
        deletions: prData.deletions,
        changedFiles: prData.changed_files,
        diff,
        files,
      };
    } catch (err) {
      console.log('GitHub API failed, using mock data for demo');
      // Return mock data for demo purposes
      await new Promise(resolve => setTimeout(resolve, 1000));
      return MOCK_PR_DATA;
    } finally {
      setLoading(false);
    }
  }, []);

  return { fetchPRData, loading, error };
}
