import { describe, expect, it } from 'vitest';
import {
  classifyGitHubForbidden,
  describeGitHubForbidden,
  readGitHubErrorDetail,
  sanitizeGitHubMessage,
} from './github-errors';

const forbidden = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 403, headers });

describe('readGitHubErrorDetail', () => {
  it('reads the rate-limit headers and the JSON message', async () => {
    const detail = await readGitHubErrorDetail(
      forbidden(JSON.stringify({ message: 'API rate limit exceeded for installation.' }), {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1795408200',
      }),
    );
    expect(detail).toEqual({
      message: 'API rate limit exceeded for installation.',
      rateLimitRemaining: '0',
      rateLimitReset: '1795408200',
      retryAfter: undefined,
    });
  });

  it('carries no message from a non-JSON body', async () => {
    const detail = await readGitHubErrorDetail(forbidden('<html><body>Forbidden</body></html>'));
    expect(detail.message).toBeUndefined();
  });

  it("leaves the caller's response body unread", async () => {
    const res = forbidden(JSON.stringify({ message: 'x' }));
    await readGitHubErrorDetail(res);
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toEqual({ message: 'x' });
  });
});

describe('sanitizeGitHubMessage', () => {
  it('collapses control characters and whitespace to one line', () => {
    expect(sanitizeGitHubMessage('Resource\nnot\u0007 accessible\t by  integration')).toBe(
      'Resource not accessible by integration',
    );
  });

  it('caps length', () => {
    const out = sanitizeGitHubMessage('a'.repeat(500));
    expect(out).toHaveLength(200);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('ignores non-strings and empty text', () => {
    expect(sanitizeGitHubMessage(42)).toBeUndefined();
    expect(sanitizeGitHubMessage('   ')).toBeUndefined();
  });
});

describe('classifyGitHubForbidden', () => {
  it.each([
    [{ rateLimitRemaining: '0' }, 'rate_limit'],
    [{ message: 'API rate limit exceeded for installation ID 1.' }, 'rate_limit'],
    [{ retryAfter: '60' }, 'secondary_rate_limit'],
    [{ message: 'You have exceeded a secondary rate limit.' }, 'secondary_rate_limit'],
    [{ message: 'This installation has been suspended' }, 'suspended'],
    [{ message: 'Resource not accessible by integration' }, 'permission'],
    [
      { rateLimitRemaining: '4999', message: 'Resource not accessible by integration' },
      'permission',
    ],
    [{}, 'unknown'],
  ] as const)('%j -> %s', (detail, kind) => {
    expect(classifyGitHubForbidden(detail)).toBe(kind);
  });
});

describe('describeGitHubForbidden', () => {
  it('names a primary rate limit and its reset time', () => {
    expect(
      describeGitHubForbidden({ rateLimitRemaining: '0', rateLimitReset: '1795408200' }, 'PR #1'),
    ).toBe('Rate limited (403, primary rate limit exhausted; resets at 04:30 UTC) for PR #1.');
  });

  it("quotes GitHub's reason for a missing permission", () => {
    expect(
      describeGitHubForbidden({ message: 'Resource not accessible by integration' }, 'PR #1'),
    ).toBe(
      'Access forbidden (403) for PR #1: the token lacks permission for this request. GitHub says: "Resource not accessible by integration"',
    );
  });

  it('says plainly when GitHub gave no reason', () => {
    expect(describeGitHubForbidden({}, 'PR #1')).toMatch(/GitHub gave no reason/);
  });
});
