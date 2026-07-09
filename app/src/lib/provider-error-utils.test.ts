import { describe, expect, it } from 'vitest';
import { extractProviderErrorDetail } from './provider-error-utils';

describe('extractProviderErrorDetail', () => {
  it('reads nested provider error messages', () => {
    expect(
      extractProviderErrorDetail(
        {
          error: {
            innererror: {
              message: 'Token rate limit exceeded for this deployment.',
            },
          },
        },
        'fallback',
        true,
      ),
    ).toBe('Token rate limit exceeded for this deployment.');
  });
});
