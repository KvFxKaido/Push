/**
 * sensitive-paths.test.ts — Unit coverage for the shared path predicate
 * used by both the web sandbox dispatcher and the `pushd` daemon. The
 * old per-surface copies of this rule set were a documented drift risk
 * (Copilot on PR #516); now there is one definition and these tests
 * pin its behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  isSensitivePath,
  SENSITIVE_FILE_BASENAMES,
  SENSITIVE_FILE_EXTENSIONS,
} from './sensitive-paths';

describe('isSensitivePath', () => {
  it('returns false for empty / non-string inputs', () => {
    expect(isSensitivePath('')).toBe(false);
    // @ts-expect-error — runtime contract is "any input"; the function
    // tolerates a non-string and returns false rather than throwing.
    expect(isSensitivePath(undefined)).toBe(false);
    // @ts-expect-error — same as above
    expect(isSensitivePath(null)).toBe(false);
    // @ts-expect-error — same as above
    expect(isSensitivePath(42)).toBe(false);
  });

  it.each(['.env', '/workspace/.env', '.env.local', '.env.production', 'src/.env.staging'])(
    'flags %s as sensitive',
    (p) => {
      expect(isSensitivePath(p)).toBe(true);
    },
  );

  it.each(['.env.example', '.env.sample', '.env.template', '.env.schema', 'src/.env.example'])(
    'does NOT flag %s (environment template)',
    (p) => {
      expect(isSensitivePath(p)).toBe(false);
    },
  );

  it.each(['.npmrc', '.pypirc', '.netrc', '.git-credentials'])(
    'flags credential basename %s',
    (p) => {
      expect(isSensitivePath(p)).toBe(true);
    },
  );

  it.each(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])(
    'flags ssh private key basename %s',
    (p) => {
      expect(isSensitivePath(p)).toBe(true);
    },
  );

  it.each(['cert.pem', 'private.key', 'cred.p12', 'apple.pfx'])(
    'flags credential extension %s',
    (p) => {
      expect(isSensitivePath(p)).toBe(true);
    },
  );

  it.each([
    '/home/user/.ssh',
    '/home/user/.ssh/config',
    '/home/user/.ssh/id_ed25519',
    'subdir/.ssh/known_hosts',
  ])('flags anything under .ssh: %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it('flags .aws/credentials and .docker/config.json', () => {
    expect(isSensitivePath('/home/user/.aws/credentials')).toBe(true);
    expect(isSensitivePath('/root/.docker/config.json')).toBe(true);
  });

  it.each([
    'src/app.ts',
    '/workspace/README.md',
    'package.json',
    'some.envfile', // suffix-matches `.env`? No — `.envfile` is not `.env` nor `.env.<x>`
  ])('does NOT flag ordinary file %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });

  it('normalizes mixed and double slashes before matching', () => {
    expect(isSensitivePath('//home//user//.ssh//id_rsa')).toBe(true);
    expect(isSensitivePath('C:\\Users\\me\\.ssh\\id_rsa')).toBe(true);
  });

  it('exports the data tables so callers can introspect or extend (read-only)', () => {
    // Pin the current set so a future addition to the rule set is an
    // intentional change with a corresponding test update.
    expect(SENSITIVE_FILE_EXTENSIONS).toEqual(['.pem', '.key', '.p12', '.pfx']);
    expect(SENSITIVE_FILE_BASENAMES.has('id_rsa')).toBe(true);
    expect(SENSITIVE_FILE_BASENAMES.has('package.json')).toBe(false);
  });
});
