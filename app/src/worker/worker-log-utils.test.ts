import { describe, expect, it } from 'vitest';
import { sanitizeUrlForLogging } from './worker-log-utils';

describe('sanitizeUrlForLogging', () => {
  it('strips query strings', () => {
    expect(
      sanitizeUrlForLogging(
        'https://push.example.test/?installation_id=12345&setup_action=install',
      ),
    ).toBe('https://push.example.test/');
  });

  it('strips fragments', () => {
    expect(sanitizeUrlForLogging('https://push.example.test/workspace#access_token=secret')).toBe(
      'https://push.example.test/workspace',
    );
  });

  it('preserves origin and pathname', () => {
    expect(sanitizeUrlForLogging('https://push.example.test:8787/api/search?q=private')).toBe(
      'https://push.example.test:8787/api/search',
    );
  });

  it('leaves URLs without query or fragment unchanged', () => {
    expect(sanitizeUrlForLogging('https://push.example.test/api/health')).toBe(
      'https://push.example.test/api/health',
    );
  });

  it('uses a fixed fallback for invalid URLs', () => {
    expect(sanitizeUrlForLogging('not a url?code=secret')).toBe('[invalid-url]');
  });
});
