import { describe, expect, it } from 'vitest';
import { SANDBOX_ROUTES, buildModalFunctionUrl, resolveModalSandboxBase } from './sandbox-modal';

describe('SANDBOX_ROUTES', () => {
  it('includes browser routes', () => {
    expect(SANDBOX_ROUTES['browser-screenshot']).toBe('browser-screenshot');
    expect(SANDBOX_ROUTES['browser-extract']).toBe('browser-extract');
  });

  it('includes all expected routes and no extras', () => {
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
      expect(SANDBOX_ROUTES[route as keyof typeof SANDBOX_ROUTES]).toBeDefined();
    }

    for (const key of Object.keys(SANDBOX_ROUTES)) {
      expect(expectedRoutes.includes(key)).toBe(true);
    }
  });
});

describe('resolveModalSandboxBase', () => {
  it('accepts a root modal app base URL', () => {
    const result = resolveModalSandboxBase('https://user--push-sandbox');
    expect(result).toEqual({ ok: true, base: 'https://user--push-sandbox' });
  });

  it('normalizes canonical .modal.run app hosts', () => {
    const result = resolveModalSandboxBase('https://alice--my-create.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://alice--my-create' });
  });

  it('preserves app names that end with route-like suffixes', () => {
    const result = resolveModalSandboxBase('https://alice--project-cleanup.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://alice--project-cleanup' });
  });

  it('rejects trailing slash in base URL', () => {
    const result = resolveModalSandboxBase('https://user--push-sandbox/');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MODAL_URL_TRAILING_SLASH');
    }
  });
});

describe('buildModalFunctionUrl', () => {
  it('constructs function endpoint from normalized base', () => {
    const modalUrl = buildModalFunctionUrl('https://user--push-sandbox', SANDBOX_ROUTES['browser-screenshot']);
    expect(modalUrl).toBe('https://user--push-sandbox-browser-screenshot.modal.run');
  });
});
