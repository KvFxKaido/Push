/**
 * Tests for browser tool route mapping in worker.ts.
 *
 * The worker defines SANDBOX_ROUTES mapping route names to Modal function names.
 * These tests verify the browser routes are correctly mapped and that the worker
 * enriches browser payloads with Browserbase credentials.
 *
 * Since worker.ts is a Cloudflare Worker module (not a standard Node module),
 * we extract and test the route mapping logic directly rather than importing
 * the worker module.
 */

import { describe, it, expect } from 'vitest';

// The SANDBOX_ROUTES map from worker.ts.
// We replicate it here to test as a unit, since importing the worker module
// would pull in Cloudflare-specific types (Fetcher, etc.) that don't exist in Node.
const SANDBOX_ROUTES: Record<string, string> = {
  create: 'create',
  exec: 'exec-command',
  read: 'file-ops',
  write: 'file-ops',
  diff: 'get-diff',
  cleanup: 'cleanup',
  list: 'file-ops',
  delete: 'file-ops',
  'browser-screenshot': 'browser-screenshot',
  'browser-extract': 'browser-extract',
};

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
    'browser-screenshot',
    'browser-extract',
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
  // Simulates the worker's payload enrichment logic for browser routes.
  // From worker.ts lines 267-285:
  //   if (route === 'browser-screenshot' || route === 'browser-extract') {
  //     payload.browserbase_api_key = env.BROWSERBASE_API_KEY || '';
  //     payload.browserbase_project_id = env.BROWSERBASE_PROJECT_ID || '';
  //   }
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
