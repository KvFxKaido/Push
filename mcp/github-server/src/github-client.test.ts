import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, githubFetch, parseNextLink, formatGitHubError } from './github-client.js';

describe('buildHeaders', () => {
  it('includes the Accept header', () => {
    const headers = buildHeaders('tok_abc');
    assert.equal(headers.Accept, 'application/vnd.github.v3+json');
  });

  it('adds Authorization when token is provided', () => {
    const headers = buildHeaders('tok_abc');
    assert.equal(headers['Authorization'], 'token tok_abc');
  });

  it('omits Authorization when token is empty', () => {
    const headers = buildHeaders('');
    assert.equal(headers['Authorization'], undefined);
  });
});

describe('parseNextLink', () => {
  it('returns the next URL from a valid Link header', () => {
    const header =
      '<https://api.github.com/repos?page=2>; rel="next", <https://api.github.com/repos?page=5>; rel="last"';
    assert.equal(parseNextLink(header), 'https://api.github.com/repos?page=2');
  });

  it('returns null when Link header is null', () => {
    assert.equal(parseNextLink(null), null);
  });

  it('returns null when there is no rel="next"', () => {
    const header = '<https://api.github.com/repos?page=1>; rel="prev"';
    assert.equal(parseNextLink(header), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(parseNextLink(''), null);
  });
});

describe('formatGitHubError', () => {
  it('formats a 404 without branch', () => {
    const msg = formatGitHubError(404, 'path/file.ts');
    assert.match(msg, /Not found/);
    assert.ok(msg.includes('path/file.ts'));
    // Without a branch argument, no specific branch name should appear in quotes
    assert.ok(!msg.includes('on branch "'));
  });

  it('formats a 404 with branch hint', () => {
    const msg = formatGitHubError(404, 'path/file.ts', 'develop');
    assert.match(msg, /Not found/);
    assert.ok(msg.includes('develop'));
  });

  it('formats a 403', () => {
    const msg = formatGitHubError(403, 'repo/contents');
    assert.match(msg, /forbidden/i);
  });

  it('formats a 429', () => {
    const msg = formatGitHubError(429, 'repo/contents');
    assert.match(msg, /rate limited/i);
  });

  it('formats a 401', () => {
    const msg = formatGitHubError(401, 'repo/contents');
    assert.match(msg, /unauthorized/i);
  });

  it('formats server errors (500, 502, 503)', () => {
    for (const status of [500, 502, 503]) {
      const msg = formatGitHubError(status, 'repo/contents');
      assert.match(msg, /server error/i);
      assert.ok(msg.includes(String(status)));
    }
  });

  it('formats an unknown status code', () => {
    const msg = formatGitHubError(418, 'repo/contents');
    assert.ok(msg.includes('418'));
    assert.ok(msg.includes('repo/contents'));
  });
});

describe('githubFetch', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a successful response on first try', async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
    globalThis.fetch = mock.fn(async () => mockResponse) as typeof fetch;

    const response = await githubFetch('https://api.github.com/repos/test');
    assert.equal(response.status, 200);
    assert.equal((globalThis.fetch as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('retries on 500 and eventually returns the response', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('error', { status: 500 });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const response = await githubFetch('https://api.github.com/repos/test');
    assert.equal(response.status, 200);
    assert.equal(callCount, 3);
  });

  it('retries on 429 and respects Retry-After header', async () => {
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const response = await githubFetch('https://api.github.com/repos/test');
    assert.equal(response.status, 200);
    assert.equal(callCount, 2);
  });

  it('does not retry on a 4xx that is not 429', async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const response = await githubFetch('https://api.github.com/repos/test');
    assert.equal(response.status, 404);
    assert.equal((globalThis.fetch as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('returns the last failing response after exhausting retries on 5xx', async () => {
    // Note: This test waits ~7s due to exponential backoff (1s + 2s + 4s)
    globalThis.fetch = mock.fn(async () => {
      return new Response('server error', { status: 502 });
    }) as typeof fetch;

    const response = await githubFetch('https://api.github.com/repos/test');
    assert.equal(response.status, 502);
  });

  it('throws on persistent network errors', async () => {
    // Note: This test waits ~7s due to exponential backoff retries
    globalThis.fetch = mock.fn(async () => {
      throw new Error('Network failure');
    }) as typeof fetch;

    await assert.rejects(
      () => githubFetch('https://api.github.com/repos/test'),
      (err: Error) => {
        assert.ok(err.message.includes('Network failure'));
        return true;
      },
    );
  });

  it('wraps AbortError as a timeout message', async () => {
    // Note: This test waits ~7s due to retry on what looks like a transient error
    globalThis.fetch = mock.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as typeof fetch;

    await assert.rejects(
      () => githubFetch('https://api.github.com/repos/test'),
      (err: Error) => {
        assert.ok(err.message.includes('timed out'));
        return true;
      },
    );
  });

  it('passes request options through to fetch', async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = mock.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await githubFetch('https://api.github.com/repos/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    const headers = calls[0].headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
  });
});
