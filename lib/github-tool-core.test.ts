import { describe, expect, it } from 'vitest';
import {
  executeGitHubCoreTool,
  type GitHubCoreRuntime,
  type GitHubCoreToolCall,
} from './github-tool-core.js';

interface CannedResponse {
  status?: number;
  body?: unknown;
  text?: string;
}

type FetchHandler = (url: string, init?: RequestInit) => CannedResponse;

function makeRuntime(
  handler: FetchHandler,
  redact?: (text: string) => { text: string; redacted: boolean },
): { runtime: GitHubCoreRuntime; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const runtime: GitHubCoreRuntime = {
    async githubFetch(url, init) {
      calls.push({ url, init });
      const canned = handler(url, init);
      const status = canned.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return canned.body;
        },
        async text() {
          return canned.text ?? '';
        },
        headers: new Headers(),
      } as unknown as Response;
    },
    buildHeaders: () => ({}),
    buildApiUrl: (path) => `https://api.github.com${path}`,
    decodeBase64: (content) => Buffer.from(content, 'base64').toString('utf8'),
    isSensitivePath: () => false,
    redactSensitiveText: redact ?? ((text) => ({ text, redacted: false })),
    formatSensitivePathToolError: (path) => `blocked ${path}`,
  };
  return { runtime, calls };
}

function run(runtime: GitHubCoreRuntime, call: GitHubCoreToolCall) {
  return executeGitHubCoreTool(runtime, call);
}

describe('get_job_logs', () => {
  const jobs = {
    jobs: [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
    ],
  };

  it('fetches logs only for failed jobs by default', async () => {
    const { runtime, calls } = makeRuntime((url) => {
      if (url.includes('/actions/runs/5/jobs')) return { body: jobs };
      if (url.includes('/actions/jobs/2/logs')) return { text: 'compile ok\nassertion failed' };
      if (url.includes('/actions/jobs/1/logs')) return { text: 'should not be fetched' };
      return { status: 404 };
    });
    const result = await run(runtime, { tool: 'get_job_logs', args: { repo: 'o/r', run_id: 5 } });

    // Only the failed job's logs endpoint is hit.
    expect(calls.some((c) => c.url.includes('/actions/jobs/2/logs'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/actions/jobs/1/logs'))).toBe(false);
    expect(result.text).toContain('test (failure)');
    expect(result.text).toContain('assertion failed');
    expect(result.text).not.toContain('build (success)');
  });

  it('includes all jobs when failed_only is false', async () => {
    const { runtime, calls } = makeRuntime((url) => {
      if (url.includes('/actions/runs/5/jobs')) return { body: jobs };
      if (url.includes('/actions/jobs/1/logs')) return { text: 'build log' };
      if (url.includes('/actions/jobs/2/logs')) return { text: 'test log' };
      return { status: 404 };
    });
    const result = await run(runtime, {
      tool: 'get_job_logs',
      args: { repo: 'o/r', run_id: 5, failed_only: false },
    });
    expect(calls.some((c) => c.url.includes('/actions/jobs/1/logs'))).toBe(true);
    expect(result.text).toContain('build (success)');
    expect(result.text).toContain('test (failure)');
  });

  it('reports no failed jobs and suggests failed_only:false', async () => {
    const { runtime } = makeRuntime((url) => {
      if (url.includes('/actions/runs/5/jobs')) return { body: { jobs: [jobs.jobs[0]] } }; // only the success job
      return { status: 404 };
    });
    const result = await run(runtime, { tool: 'get_job_logs', args: { repo: 'o/r', run_id: 5 } });
    expect(result.text).toContain('No failed jobs');
    expect(result.text).toContain('failed_only: false');
  });

  it('tails to the requested number of lines', async () => {
    const longLog = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { runtime } = makeRuntime((url) => {
      if (url.includes('/actions/runs/5/jobs')) return { body: { jobs: [jobs.jobs[1]] } };
      if (url.includes('/actions/jobs/2/logs')) return { text: longLog };
      return { status: 404 };
    });
    const result = await run(runtime, {
      tool: 'get_job_logs',
      args: { repo: 'o/r', run_id: 5, tail_lines: 3 },
    });
    expect(result.text).toContain('last 3 lines');
    expect(result.text).toContain('line 50');
    expect(result.text).not.toContain('line 1\n');
  });

  it('applies redaction to log text', async () => {
    const { runtime } = makeRuntime(
      (url) => {
        if (url.includes('/actions/runs/5/jobs')) return { body: { jobs: [jobs.jobs[1]] } };
        if (url.includes('/actions/jobs/2/logs')) return { text: 'token=SECRET123 in logs' };
        return { status: 404 };
      },
      (text) => ({
        text: text.replace('SECRET123', '[redacted]'),
        redacted: text.includes('SECRET123'),
      }),
    );
    const result = await run(runtime, { tool: 'get_job_logs', args: { repo: 'o/r', run_id: 5 } });
    expect(result.text).toContain('[redacted]');
    expect(result.text).not.toContain('SECRET123');
    expect(result.text).toContain('Redactions: secret-like values hidden.');
  });

  it('fetches a single job by job_id', async () => {
    const { runtime, calls } = makeRuntime((url) => {
      if (url.endsWith('/actions/jobs/7')) return { body: { name: 'lint', conclusion: 'failure' } };
      if (url.includes('/actions/jobs/7/logs')) return { text: 'eslint error' };
      return { status: 404 };
    });
    const result = await run(runtime, { tool: 'get_job_logs', args: { repo: 'o/r', job_id: 7 } });
    expect(calls.some((c) => c.url.includes('/actions/runs/'))).toBe(false);
    expect(result.text).toContain('lint');
    expect(result.text).toContain('eslint error');
  });

  it('does not falsely truncate a log that ends with a newline', async () => {
    // "a\nb\nc\n" is 3 real lines; tail_lines:3 must keep all of them and not
    // mark the result truncated (the trailing '' segment is not a line). The
    // single-job path surfaces the truncated flag as "(showing last N lines)".
    const { runtime } = makeRuntime((url) => {
      if (url.endsWith('/actions/jobs/9')) return { body: { name: 'j', conclusion: 'failure' } };
      if (url.includes('/actions/jobs/9/logs')) return { text: 'a\nb\nc\n' };
      return { status: 404 };
    });
    const result = await run(runtime, {
      tool: 'get_job_logs',
      args: { repo: 'o/r', job_id: 9, tail_lines: 3 },
    });
    expect(result.text).not.toContain('showing last 3 lines');
    expect(result.text).toContain('a\nb\nc');
  });
});

describe('list_issues', () => {
  it('excludes pull requests from the issue list', async () => {
    const { runtime } = makeRuntime(() => ({
      body: [
        { number: 1, title: 'A real issue', state: 'open', user: { login: 'a' }, comments: 0 },
        {
          number: 2,
          title: 'A pull request',
          state: 'open',
          user: { login: 'b' },
          pull_request: { url: 'x' },
        },
      ],
    }));
    const result = await run(runtime, { tool: 'list_issues', args: { repo: 'o/r' } });
    expect(result.text).toContain('#1 A real issue');
    expect(result.text).not.toContain('A pull request');
    expect(result.text).toContain('1 open issue');
  });

  it('over-fetches a full page and slices to the requested count', async () => {
    // Real issues interleaved with PRs; with count:2 we should still return 2
    // real issues even though PRs pad the page.
    const body = [
      { number: 10, title: 'PR a', state: 'open', user: { login: 'x' }, pull_request: {} },
      { number: 11, title: 'issue one', state: 'open', user: { login: 'x' }, comments: 0 },
      { number: 12, title: 'PR b', state: 'open', user: { login: 'x' }, pull_request: {} },
      { number: 13, title: 'issue two', state: 'open', user: { login: 'x' }, comments: 0 },
      { number: 14, title: 'issue three', state: 'open', user: { login: 'x' }, comments: 0 },
    ];
    const { runtime, calls } = makeRuntime(() => ({ body }));
    const result = await run(runtime, { tool: 'list_issues', args: { repo: 'o/r', count: 2 } });
    // Over-fetches the API max, not just `count`.
    expect(calls[0].url).toContain('per_page=100');
    expect(result.text).toContain('issue one');
    expect(result.text).toContain('issue two');
    expect(result.text).not.toContain('issue three'); // sliced to count: 2
    expect(result.text).not.toContain('PR a');
  });
});

describe('add_issue_comment', () => {
  it('POSTs the comment body and returns the URL', async () => {
    const { runtime, calls } = makeRuntime((url) => {
      if (url.includes('/issues/42/comments')) {
        return { status: 201, body: { html_url: 'https://github.com/o/r/issues/42#c1' } };
      }
      return { status: 404 };
    });
    const result = await run(runtime, {
      tool: 'add_issue_comment',
      args: { repo: 'o/r', issue_number: 42, body: 'done' },
    });
    const post = calls.find((c) => c.url.includes('/issues/42/comments'));
    expect(post?.init?.method).toBe('POST');
    expect(String(post?.init?.body)).toContain('done');
    expect(result.text).toContain('Comment posted on #42');
  });
});

describe('update_issue / update_pull_request validation', () => {
  it('throws when update_issue has no fields', async () => {
    const { runtime } = makeRuntime(() => ({ status: 200, body: {} }));
    await expect(
      run(runtime, { tool: 'update_issue', args: { repo: 'o/r', issue_number: 1 } }),
    ).rejects.toThrow(/at least one field/);
  });

  it('throws when update_pull_request has no fields', async () => {
    const { runtime } = makeRuntime(() => ({ status: 200, body: {} }));
    await expect(
      run(runtime, { tool: 'update_pull_request', args: { repo: 'o/r', pr_number: 1 } }),
    ).rejects.toThrow(/at least one field/);
  });

  it('sends an explicit empty labels array to clear all labels', async () => {
    const { runtime, calls } = makeRuntime((url) => {
      if (url.includes('/issues/1')) return { status: 200, body: { state: 'open' } };
      return { status: 404 };
    });
    await run(runtime, {
      tool: 'update_issue',
      args: { repo: 'o/r', issue_number: 1, labels: [] },
    });
    const patch = calls.find((c) => c.url.includes('/issues/1'));
    expect(patch?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ labels: [] });
  });
});

describe('list_secret_scanning_alerts', () => {
  it('withholds the raw secret value and surfaces only metadata', async () => {
    const { runtime } = makeRuntime((url) => {
      if (url.includes('/secret-scanning/alerts')) {
        return {
          body: [
            {
              number: 3,
              state: 'open',
              html_url: 'https://github.com/o/r/security/secret-scanning/3',
              secret_type_display_name: 'GitHub Personal Access Token',
              secret: 'ghp_SUPERSECRETVALUE',
            },
          ],
        };
      }
      return { status: 404 };
    });
    const result = await run(runtime, {
      tool: 'list_secret_scanning_alerts',
      args: { repo: 'o/r' },
    });
    expect(result.text).not.toContain('ghp_SUPERSECRETVALUE');
    expect(result.text).toContain('GitHub Personal Access Token');
    expect(result.text).toContain('secret values withheld');
  });

  it('reports a soft message when secret scanning is not enabled (404)', async () => {
    const { runtime } = makeRuntime(() => ({ status: 404 }));
    const result = await run(runtime, {
      tool: 'list_secret_scanning_alerts',
      args: { repo: 'o/r' },
    });
    expect(result.text).toContain('not enabled');
  });
});

describe('security alerts soft-404', () => {
  it('list_code_scanning_alerts reports not-enabled on 404', async () => {
    const { runtime } = makeRuntime(() => ({ status: 404 }));
    const result = await run(runtime, {
      tool: 'list_code_scanning_alerts',
      args: { repo: 'o/r' },
    });
    expect(result.text).toContain('Code scanning is not enabled');
  });
});
