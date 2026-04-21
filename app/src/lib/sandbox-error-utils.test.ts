import { describe, expect, it } from 'vitest';
import { categorizeSandboxError } from './sandbox-error-utils';

describe('categorizeSandboxError', () => {
  describe('sandbox session auth (CF owner-token scheme)', () => {
    it('routes AUTH_FAILURE code to "Sandbox session expired", not GitHub', () => {
      // This is the regression that inspired this test file — CF sandbox
      // owner-token mismatches were rendering as "Check your GitHub token"
      // because `AUTH_FAILURE` contains the substring "auth".
      expect(categorizeSandboxError('Owner token does not match (AUTH_FAILURE)')).toEqual({
        title: 'Sandbox session expired',
        detail: 'Start a new sandbox to continue.',
      });
    });

    it('routes owner-token mismatch message to the sandbox-session branch', () => {
      expect(categorizeSandboxError('Owner token does not match')).toEqual({
        title: 'Sandbox session expired',
        detail: 'Start a new sandbox to continue.',
      });
    });

    it('routes stale sandbox lookups to the sandbox-session branch', () => {
      expect(categorizeSandboxError('Sandbox not found or expired')).toEqual({
        title: 'Sandbox session expired',
        detail: 'Start a new sandbox to continue.',
      });
    });

    it('routes SANDBOX_TOKENS binding errors to the sandbox-session branch', () => {
      expect(
        categorizeSandboxError('SANDBOX_TOKENS KV binding not configured (NOT_CONFIGURED)'),
      ).toEqual({
        title: 'Sandbox session expired',
        detail: 'Start a new sandbox to continue.',
      });
    });
  });

  describe('genuine GitHub auth errors', () => {
    it('still routes GitHub 403 to "Check your GitHub token"', () => {
      expect(categorizeSandboxError('Repository access denied: 403 Forbidden')).toEqual({
        title: 'Authentication error',
        detail: 'Check your GitHub token in Settings.',
      });
    });

    it('routes generic permission errors to GitHub', () => {
      expect(categorizeSandboxError('permission denied on remote')).toEqual({
        title: 'Authentication error',
        detail: 'Check your GitHub token in Settings.',
      });
    });
  });

  describe('other categories (unchanged by the fix)', () => {
    it('routes clone failures correctly', () => {
      expect(categorizeSandboxError('git clone failed: remote hung up')).toEqual({
        title: 'Repository clone failed',
        detail: 'Check repo access and try a new sandbox.',
      });
    });

    it('routes timeouts correctly', () => {
      expect(categorizeSandboxError('Operation timed out after 30s')).toEqual({
        title: 'Sandbox timed out',
        detail: 'The container stopped responding.',
      });
    });

    it('routes memory errors correctly', () => {
      expect(categorizeSandboxError('FATAL: out of memory (oom)')).toEqual({
        title: 'Out of memory',
        detail: 'The sandbox ran out of memory.',
      });
    });

    it('returns the raw message for short unclassified errors', () => {
      expect(categorizeSandboxError('container restarted unexpectedly')).toEqual({
        title: 'Sandbox error',
        detail: 'container restarted unexpectedly',
      });
    });

    it('elides long unclassified errors behind a generic message', () => {
      const longError = 'x'.repeat(200);
      expect(categorizeSandboxError(longError)).toEqual({
        title: 'Sandbox error',
        detail: 'Something went wrong. Start a new sandbox to continue.',
      });
    });
  });
});
