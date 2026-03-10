import { describe, expect, it } from 'vitest';
import {
  extractProviderErrorDetail,
  formatExperimentalProviderHttpError,
} from './provider-error-utils';

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

describe('formatExperimentalProviderHttpError', () => {
  it('turns 429 responses into quota guidance', () => {
    const message = formatExperimentalProviderHttpError(
      'Azure OpenAI',
      429,
      JSON.stringify({
        error: {
          message: 'Requests to ChatCompletions exceeded tokens per minute for this deployment.',
        },
      }),
    );

    expect(message).toContain('Azure OpenAI is rate limited or out of quota.');
    expect(message).toContain('TPM/RPM');
    expect(message).toContain('exceeded tokens per minute');
  });

  it('turns missing deployments into a deployment-specific hint', () => {
    const message = formatExperimentalProviderHttpError(
      'Azure OpenAI',
      404,
      JSON.stringify({
        error: {
          message: 'The API deployment for this resource does not exist.',
        },
      }),
    );

    expect(message).toContain('deployment or model was not found');
    expect(message).toContain('deployment/model name and base URL');
  });

  it('turns auth failures into key and permissions guidance', () => {
    const message = formatExperimentalProviderHttpError(
      'Google Vertex',
      403,
      JSON.stringify({
        error: {
          message: 'Permission denied for this project.',
        },
      }),
    );

    expect(message).toContain('Google Vertex rejected the request.');
    expect(message).toContain('API key, deployment permissions, and endpoint');
  });
});
