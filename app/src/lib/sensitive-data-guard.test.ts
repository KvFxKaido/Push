import { describe, expect, it } from 'vitest';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';

describe('isSensitivePath', () => {
  it('blocks common secret-bearing files and allows templates', () => {
    expect(isSensitivePath('/workspace/.env')).toBe(true);
    expect(isSensitivePath('/workspace/.env.local')).toBe(true);
    expect(isSensitivePath('/workspace/.env.example')).toBe(false);
    expect(isSensitivePath('/workspace/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('/workspace/certs/server.pem')).toBe(true);
  });
});

describe('filterSensitiveDirectoryEntries', () => {
  it('hides sensitive entries from directory listings', () => {
    const result = filterSensitiveDirectoryEntries('/workspace', [
      { name: '.env' },
      { name: '.env.example' },
      { name: 'src' },
    ]);

    expect(result.hiddenCount).toBe(1);
    expect(result.entries.map((entry) => entry.name)).toEqual(['.env.example', 'src']);
  });
});

describe('redactSensitiveText', () => {
  it('redacts token-like secrets and private keys', () => {
    const result = redactSensitiveText([
      'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
      'OPENAI=sk-abcdefghijklmnopqrstuvwxyz123456',
      '-----BEGIN PRIVATE KEY-----',
      'topsecret',
      '-----END PRIVATE KEY-----',
    ].join('\n'));

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).toContain('[REDACTED PRIVATE KEY]');
  });

  it('formats a clear tool error for blocked secret paths', () => {
    expect(formatSensitivePathToolError('/workspace/.env')).toContain('Access denied');
  });
});
