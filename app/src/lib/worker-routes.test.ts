import { describe, it, expect } from 'vitest';
import { SANDBOX_ROUTES, resolveModalSandboxBase } from './sandbox-routes';

// ---------------------------------------------------------------------------
// 1. Route mapping — browser-screenshot
// ---------------------------------------------------------------------------

describe('SANDBOX_ROUTES — browser-screenshot', () => {
  it('maps browser-screenshot route to browser-screenshot Modal function', () => {
    expect(SANDBOX_ROUTES['browser-screenshot']).toBe('browser-screenshot');
  });

  it('browser-screenshot is a defined route (not undefined)', () => {
    expect('browser-screenshot' in SANDBOX_ROUTES).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Route mapping — browser-extract
// ---------------------------------------------------------------------------

describe('SANDBOX_ROUTES — browser-extract', () => {
  it('maps browser-extract route to browser-extract Modal function', () => {
    expect(SANDBOX_ROUTES['browser-extract']).toBe('browser-extract');
  });

  it('browser-extract is a defined route (not undefined)', () => {
    expect('browser-extract' in SANDBOX_ROUTES).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Route completeness — all expected routes exist
// ---------------------------------------------------------------------------

describe('SANDBOX_ROUTES — completeness', () => {
  const expectedRoutes = [
    'create',
    'exec',
    'read',
    'write',
    'diff',
    'cleanup',
    'list',
    'delete',
    'restore',
    'browser-screenshot',
    'browser-extract',
    'download',
  ];

  for (const route of expectedRoutes) {
    it(`has route "${route}" defined`, () => {
      expect(SANDBOX_ROUTES[route]).toBeDefined();
    });
  }

  it('does not have unexpected routes beyond the known set', () => {
    const knownRoutes = new Set(expectedRoutes);
    for (const key of Object.keys(SANDBOX_ROUTES)) {
      expect(knownRoutes.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Modal URL construction
// ---------------------------------------------------------------------------

describe('Modal URL construction for browser routes', () => {
  const baseUrl = 'https://user--push-sandbox';

  it('constructs correct Modal URL for browser-screenshot', () => {
    const modalFunction = SANDBOX_ROUTES['browser-screenshot'];
    const modalUrl = `${baseUrl}-${modalFunction}.modal.run`;
    expect(modalUrl).toBe('https://user--push-sandbox-browser-screenshot.modal.run');
  });

  it('constructs correct Modal URL for browser-extract', () => {
    const modalFunction = SANDBOX_ROUTES['browser-extract'];
    const modalUrl = `${baseUrl}-${modalFunction}.modal.run`;
    expect(modalUrl).toBe('https://user--push-sandbox-browser-extract.modal.run');
  });
});

// ---------------------------------------------------------------------------
// 5. Payload enrichment for browser routes
// ---------------------------------------------------------------------------

describe('Worker payload enrichment for browser routes', () => {
  function enrichPayload(
    route: string,
    payload: Record<string, unknown>,
    env: { BROWSERBASE_API_KEY?: string; BROWSERBASE_PROJECT_ID?: string },
  ): Record<string, unknown> {
    if (route === 'browser-screenshot' || route === 'browser-extract') {
      return {
        ...payload,
        browserbase_api_key: env.BROWSERBASE_API_KEY || '',
        browserbase_project_id: env.BROWSERBASE_PROJECT_ID || '',
      };
    }
    return payload;
  }

  it('adds Browserbase credentials for browser-screenshot', () => {
    const result = enrichPayload(
      'browser-screenshot',
      { sandbox_id: 'sb-1', url: 'https://example.com', owner_token: 'tok' },
      { BROWSERBASE_API_KEY: 'bb-key-123', BROWSERBASE_PROJECT_ID: 'proj-456' },
    );

    expect(result.browserbase_api_key).toBe('bb-key-123');
    expect(result.browserbase_project_id).toBe('proj-456');
    expect(result.sandbox_id).toBe('sb-1');
    expect(result.url).toBe('https://example.com');
  });

  it('adds Browserbase credentials for browser-extract', () => {
    const result = enrichPayload(
      'browser-extract',
      { sandbox_id: 'sb-1', url: 'https://example.com', instruction: 'test', owner_token: 'tok' },
      { BROWSERBASE_API_KEY: 'bb-key', BROWSERBASE_PROJECT_ID: 'proj' },
    );

    expect(result.browserbase_api_key).toBe('bb-key');
    expect(result.browserbase_project_id).toBe('proj');
  });

  it('uses empty strings when env vars are missing', () => {
    const result = enrichPayload(
      'browser-screenshot',
      { sandbox_id: 'sb-1', url: 'https://example.com', owner_token: 'tok' },
      {},
    );

    expect(result.browserbase_api_key).toBe('');
    expect(result.browserbase_project_id).toBe('');
  });

  it('does not add Browserbase credentials for non-browser routes', () => {
    const result = enrichPayload(
      'exec',
      { sandbox_id: 'sb-1', command: 'ls' },
      { BROWSERBASE_API_KEY: 'bb-key', BROWSERBASE_PROJECT_ID: 'proj' },
    );

    expect(result.browserbase_api_key).toBeUndefined();
    expect(result.browserbase_project_id).toBeUndefined();
  });
});

describe('Modal base URL normalization', () => {
  it('accepts canonical app base URL', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox')).toEqual({ ok: true, base: 'https://user--push-sandbox' });
  });

  it('accepts full app host with .modal.run suffix', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox.modal.run')).toEqual({ ok: true, base: 'https://user--push-sandbox' });
  });

  it('accepts full function URL and strips function suffix', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox-create.modal.run')).toEqual({ ok: true, base: 'https://user--push-sandbox' });
    expect(resolveModalSandboxBase('https://user--push-sandbox-exec-command.modal.run')).toEqual({ ok: true, base: 'https://user--push-sandbox' });
  });

  it('strips function URL for single-word app names', () => {
    expect(resolveModalSandboxBase('https://alice--push-create.modal.run')).toEqual({ ok: true, base: 'https://alice--push' });
    expect(resolveModalSandboxBase('https://alice--push-cleanup.modal.run')).toEqual({ ok: true, base: 'https://alice--push' });
  });

  it('rejects non-https and trailing slash forms', () => {
    expect(resolveModalSandboxBase('http://user--push-sandbox')).toMatchObject({ ok: false, code: 'MODAL_URL_INVALID' });
    expect(resolveModalSandboxBase('https://user--push-sandbox/')).toMatchObject({ ok: false, code: 'MODAL_URL_TRAILING_SLASH' });
  });
});
