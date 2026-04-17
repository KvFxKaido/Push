import { describe, expect, it } from 'vitest';
import { resolveModalSandboxBase, SANDBOX_ROUTES } from './sandbox-routes';

describe('sandbox-routes — SANDBOX_ROUTES table', () => {
  it('maps every sandbox action to a concrete Modal function path', () => {
    expect(SANDBOX_ROUTES).toMatchObject({
      create: 'create',
      exec: 'exec-command',
      read: 'file-ops',
      write: 'file-ops',
      diff: 'get-diff',
      cleanup: 'cleanup',
      list: 'file-ops',
      delete: 'file-ops',
      restore: 'file-ops',
      'batch-write': 'file-ops',
      download: 'create-archive',
      hibernate: 'snapshot-and-terminate',
      'restore-snapshot': 'restore-from-snapshot',
    });
  });
});

describe('sandbox-routes — resolveModalSandboxBase input guards', () => {
  it('rejects non-https URLs', () => {
    const result = resolveModalSandboxBase('http://ws-user--push.modal.run');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_INVALID');
  });

  it('rejects URLs with a trailing slash', () => {
    const result = resolveModalSandboxBase('https://ws-user--push.modal.run/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_TRAILING_SLASH');
  });

  it('rejects strings that URL() cannot parse', () => {
    // `https://[` is a well-formed prefix that passes the trailing-slash and
    // scheme guards but fails `new URL(...)` parsing, landing in the catch.
    const result = resolveModalSandboxBase('https://[');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_INVALID');
  });
});

describe('sandbox-routes — .modal.run hosts', () => {
  it('accepts a bare app URL and strips the .modal.run suffix', () => {
    const result = resolveModalSandboxBase('https://ws-user--push.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://ws-user--push' });
  });

  it('strips a known function suffix from a Modal function URL', () => {
    const result = resolveModalSandboxBase('https://ws-user--push-exec-command.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://ws-user--push' });
  });

  it('strips the file-ops suffix when the user pastes a deploy-output URL', () => {
    const result = resolveModalSandboxBase('https://ws-user--push-file-ops.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://ws-user--push' });
  });

  it('keeps the host when the suffix does not match any known route', () => {
    const result = resolveModalSandboxBase('https://ws-user--push-custom.modal.run');
    expect(result).toEqual({ ok: true, base: 'https://ws-user--push-custom' });
  });

  it('rejects a host missing the namespace separator', () => {
    const result = resolveModalSandboxBase('https://plainapp.modal.run');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_INVALID');
  });

  it('rejects a host with no app name after the separator', () => {
    const result = resolveModalSandboxBase('https://ws-user--.modal.run');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_INVALID');
  });
});

describe('sandbox-routes — custom domains', () => {
  it('accepts a custom host as long as it contains the namespace separator', () => {
    const result = resolveModalSandboxBase('https://ws-user--push.example.dev');
    expect(result).toEqual({ ok: true, base: 'https://ws-user--push.example.dev' });
  });

  it('rejects a custom host with no namespace separator', () => {
    const result = resolveModalSandboxBase('https://push.example.dev');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MODAL_URL_INVALID');
  });
});
