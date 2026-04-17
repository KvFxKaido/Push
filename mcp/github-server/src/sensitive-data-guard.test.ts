import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard.js';

describe('isSensitivePath', () => {
  it('blocks .env and common variants', () => {
    assert.equal(isSensitivePath('/workspace/.env'), true);
    assert.equal(isSensitivePath('/workspace/.env.local'), true);
    assert.equal(isSensitivePath('/workspace/.env.production'), true);
  });

  it('allows .env template files', () => {
    assert.equal(isSensitivePath('/workspace/.env.example'), false);
    assert.equal(isSensitivePath('/workspace/.env.sample'), false);
    assert.equal(isSensitivePath('/workspace/.env.template'), false);
    assert.equal(isSensitivePath('/workspace/.env.schema'), false);
  });

  it('blocks SSH private-key files by basename', () => {
    assert.equal(isSensitivePath('/home/u/.ssh/id_rsa'), true);
    assert.equal(isSensitivePath('/home/u/.ssh/id_ed25519'), true);
    assert.equal(isSensitivePath('/home/u/.ssh/id_ecdsa'), true);
    assert.equal(isSensitivePath('/home/u/.ssh/id_dsa'), true);
  });

  it('blocks dotfiles carrying credentials', () => {
    assert.equal(isSensitivePath('/home/u/.npmrc'), true);
    assert.equal(isSensitivePath('/home/u/.pypirc'), true);
    assert.equal(isSensitivePath('/home/u/.netrc'), true);
    assert.equal(isSensitivePath('/home/u/.git-credentials'), true);
  });

  it('blocks common credential/cert extensions', () => {
    assert.equal(isSensitivePath('/certs/server.pem'), true);
    assert.equal(isSensitivePath('/certs/server.key'), true);
    assert.equal(isSensitivePath('/certs/client.p12'), true);
    assert.equal(isSensitivePath('/certs/client.pfx'), true);
  });

  it('blocks paths under .ssh and typical cloud credential paths', () => {
    assert.equal(isSensitivePath('/home/u/.ssh/authorized_keys'), true);
    assert.equal(isSensitivePath('/home/u/.aws/credentials'), true);
    assert.equal(isSensitivePath('/home/u/.docker/config.json'), true);
  });

  it('normalises Windows-style separators', () => {
    assert.equal(isSensitivePath('C:\\Users\\me\\.ssh\\id_rsa'), true);
    assert.equal(isSensitivePath('C:\\app\\.env'), true);
  });

  it('returns false for ordinary source paths', () => {
    assert.equal(isSensitivePath('/workspace/src/index.ts'), false);
    assert.equal(isSensitivePath('/workspace/README.md'), false);
  });

  it('returns false for the empty path', () => {
    assert.equal(isSensitivePath(''), false);
    assert.equal(isSensitivePath('   '), false);
  });
});

describe('filterSensitiveDirectoryEntries', () => {
  it('hides sensitive entries and counts them', () => {
    const { entries, hiddenCount } = filterSensitiveDirectoryEntries('/workspace', [
      { name: '.env' },
      { name: '.env.example' },
      { name: 'id_rsa' },
      { name: 'src' },
    ]);
    assert.equal(hiddenCount, 2);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['.env.example', 'src'],
    );
  });

  it('prefers the explicit path field over the directory/name join', () => {
    const { entries, hiddenCount } = filterSensitiveDirectoryEntries('/workspace', [
      { name: 'foo.txt', path: '/workspace/.ssh/id_rsa' },
      { name: 'bar.txt', path: '/workspace/bar.txt' },
    ]);
    assert.equal(hiddenCount, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'bar.txt');
  });

  it('returns entries unchanged when nothing is sensitive', () => {
    const { entries, hiddenCount } = filterSensitiveDirectoryEntries('/workspace', [
      { name: 'a.ts' },
      { name: 'b.ts' },
    ]);
    assert.equal(hiddenCount, 0);
    assert.equal(entries.length, 2);
  });

  it('handles an empty entry list', () => {
    const { entries, hiddenCount } = filterSensitiveDirectoryEntries('/workspace', []);
    assert.equal(hiddenCount, 0);
    assert.deepEqual(entries, []);
  });
});

describe('redactSensitiveText', () => {
  it('redacts PEM-encoded private keys', () => {
    const { text, redacted } = redactSensitiveText(
      ['-----BEGIN PRIVATE KEY-----', 'MIIE...', '-----END PRIVATE KEY-----'].join('\n'),
    );
    assert.equal(redacted, true);
    assert.ok(text.includes('[REDACTED PRIVATE KEY]'));
    assert.ok(!text.includes('MIIE'));
  });

  it('redacts RSA and EC flavored PEM blocks', () => {
    const rsa = redactSensitiveText(
      '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
    );
    assert.equal(rsa.redacted, true);
    assert.ok(rsa.text.includes('[REDACTED PRIVATE KEY]'));

    const ec = redactSensitiveText(
      '-----BEGIN EC PRIVATE KEY-----\nBBBB\n-----END EC PRIVATE KEY-----',
    );
    assert.equal(ec.redacted, true);
    assert.ok(ec.text.includes('[REDACTED PRIVATE KEY]'));
  });

  it('redacts GitHub tokens (classic and fine-grained)', () => {
    const classic = redactSensitiveText('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    assert.equal(classic.redacted, true);
    assert.ok(classic.text.includes('[REDACTED GITHUB TOKEN]'));

    const pat = redactSensitiveText('pat=github_pat_11AAAAAAAAAAAAAAAAAAAA_zzzzzzzzzzzzzz');
    assert.equal(pat.redacted, true);
    assert.ok(pat.text.includes('[REDACTED GITHUB TOKEN]'));
  });

  it('redacts OpenAI-style and Google API keys', () => {
    const openai = redactSensitiveText('key=sk-ABCDEFGHIJKLMNOPQRSTUV');
    assert.equal(openai.redacted, true);
    assert.ok(openai.text.includes('[REDACTED API KEY]'));

    const google = redactSensitiveText('key=AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(google.redacted, true);
    assert.ok(google.text.includes('[REDACTED GOOGLE API KEY]'));
  });

  it('redacts AWS access keys', () => {
    const { text, redacted } = redactSensitiveText('AWS_KEY=AKIAIOSFODNN7EXAMPLE');
    assert.equal(redacted, true);
    assert.ok(text.includes('[REDACTED AWS ACCESS KEY]'));
  });

  it('redacts AWS secret access keys while preserving the prefix', () => {
    const { text, redacted } = redactSensitiveText(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    assert.equal(redacted, true);
    assert.ok(text.startsWith('AWS_SECRET_ACCESS_KEY='));
    assert.ok(text.includes('[REDACTED]'));
    assert.ok(!text.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
  });

  it('redacts Bearer tokens while preserving the scheme', () => {
    const { text, redacted } = redactSensitiveText(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    );
    assert.equal(redacted, true);
    assert.ok(text.includes('Bearer [REDACTED TOKEN]'));
  });

  it('returns unchanged text and false when nothing looks sensitive', () => {
    const input = 'This is a plain README with no secrets.';
    const { text, redacted } = redactSensitiveText(input);
    assert.equal(redacted, false);
    assert.equal(text, input);
  });

  it('redacts multiple distinct secrets in the same input', () => {
    const input = [
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'OPENAI=sk-ABCDEFGHIJKLMNOPQRSTUV',
      '-----BEGIN PRIVATE KEY-----',
      'XXX',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const { text, redacted } = redactSensitiveText(input);
    assert.equal(redacted, true);
    assert.ok(text.includes('Bearer [REDACTED TOKEN]'));
    assert.ok(text.includes('[REDACTED API KEY]'));
    assert.ok(text.includes('[REDACTED PRIVATE KEY]'));
  });
});

describe('formatSensitivePathToolError', () => {
  it('includes the offending path and an access-denied phrase', () => {
    const msg = formatSensitivePathToolError('/workspace/.env');
    assert.match(msg, /Access denied/);
    assert.ok(msg.includes('/workspace/.env'));
  });
});
