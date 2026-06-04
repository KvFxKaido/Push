import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api-url', () => ({ resolveApiUrl: (p: string) => `https://x${p}` }));
vi.mock('./github-auth', () => ({ getActiveInstallationId: () => '' }));

import { checkRepoCoverage } from './github-repo-coverage';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('checkRepoCoverage fail-open mapping', () => {
  it('maps covered:true → covered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ covered: true, install_url: 'u' })),
    );
    expect(await checkRepoCoverage('o/r')).toEqual({ coverage: 'covered', installUrl: 'u' });
  });

  it('maps covered:false → not_covered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ covered: false })),
    );
    expect((await checkRepoCoverage('o/r')).coverage).toBe('not_covered');
  });

  it('maps a non-boolean covered (schema drift) → unknown, never blocking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ weird: 1 })),
    );
    expect((await checkRepoCoverage('o/r')).coverage).toBe('unknown');
  });

  it('maps a non-OK response → unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({}, 500)),
    );
    expect((await checkRepoCoverage('o/r')).coverage).toBe('unknown');
  });

  it('maps a network error → unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('net');
      }),
    );
    expect((await checkRepoCoverage('o/r')).coverage).toBe('unknown');
  });
});
