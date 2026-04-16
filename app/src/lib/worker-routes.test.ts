import { describe, it, expect } from 'vitest';
import { SANDBOX_ROUTES, resolveModalSandboxBase } from './sandbox-routes';

// ---------------------------------------------------------------------------
// 1. Route completeness — all expected routes exist
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
    'batch-write',
    'download',
    'hibernate',
    'restore-snapshot',
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
// 2. Modal base URL normalization
// ---------------------------------------------------------------------------

describe('Modal base URL normalization', () => {
  it('accepts canonical app base URL', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox')).toEqual({
      ok: true,
      base: 'https://user--push-sandbox',
    });
  });

  it('accepts full app host with .modal.run suffix', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox.modal.run')).toEqual({
      ok: true,
      base: 'https://user--push-sandbox',
    });
  });

  it('accepts full function URL and strips function suffix', () => {
    expect(resolveModalSandboxBase('https://user--push-sandbox-create.modal.run')).toEqual({
      ok: true,
      base: 'https://user--push-sandbox',
    });
    expect(resolveModalSandboxBase('https://user--push-sandbox-exec-command.modal.run')).toEqual({
      ok: true,
      base: 'https://user--push-sandbox',
    });
  });

  it('strips function URL for single-word app names', () => {
    expect(resolveModalSandboxBase('https://alice--push-create.modal.run')).toEqual({
      ok: true,
      base: 'https://alice--push',
    });
    expect(resolveModalSandboxBase('https://alice--push-cleanup.modal.run')).toEqual({
      ok: true,
      base: 'https://alice--push',
    });
    expect(resolveModalSandboxBase('https://alice--sandbox-create.modal.run')).toEqual({
      ok: true,
      base: 'https://alice--sandbox',
    });
  });

  it('rejects non-https and trailing slash forms', () => {
    expect(resolveModalSandboxBase('http://user--push-sandbox')).toMatchObject({
      ok: false,
      code: 'MODAL_URL_INVALID',
    });
    expect(resolveModalSandboxBase('https://user--push-sandbox/')).toMatchObject({
      ok: false,
      code: 'MODAL_URL_TRAILING_SLASH',
    });
  });
});
