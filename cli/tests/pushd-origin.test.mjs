import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrigin,
  OriginNormalizationError,
  isLoopbackOrigin,
  checkOrigin,
} from '../pushd-origin.ts';

describe('normalizeOrigin', () => {
  it('lowercases scheme and host', () => {
    assert.equal(normalizeOrigin('HTTPS://Push.Zen-Dev.com'), 'https://push.zen-dev.com');
  });

  it('strips path, query, hash, and trailing slash', () => {
    assert.equal(
      normalizeOrigin('https://push.zen-dev.com/workspace/hub'),
      'https://push.zen-dev.com',
    );
    assert.equal(normalizeOrigin('https://push.zen-dev.com/?x=1#frag'), 'https://push.zen-dev.com');
    assert.equal(normalizeOrigin('https://push.zen-dev.com/'), 'https://push.zen-dev.com');
  });

  it('elides default ports (matches browser Origin header behaviour)', () => {
    assert.equal(normalizeOrigin('https://example.com:443'), 'https://example.com');
    assert.equal(normalizeOrigin('http://example.com:80'), 'http://example.com');
  });

  it('preserves non-default port', () => {
    assert.equal(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173');
    assert.equal(normalizeOrigin('https://example.com:8443'), 'https://example.com:8443');
  });

  it('rejects userinfo (user:pass@host)', () => {
    assert.throws(() => normalizeOrigin('https://user:pass@example.com'), OriginNormalizationError);
    assert.throws(() => normalizeOrigin('https://user@example.com'), OriginNormalizationError);
  });

  it('rejects non-http schemes', () => {
    assert.throws(() => normalizeOrigin('ws://example.com'), OriginNormalizationError);
    assert.throws(() => normalizeOrigin('file:///tmp/x'), OriginNormalizationError);
    assert.throws(() => normalizeOrigin('javascript:alert(1)'), OriginNormalizationError);
  });

  it('rejects unparseable input', () => {
    assert.throws(() => normalizeOrigin(''), OriginNormalizationError);
    assert.throws(() => normalizeOrigin('not a url'), OriginNormalizationError);
    assert.throws(() => normalizeOrigin('https://'), OriginNormalizationError);
  });

  it('IPv6 hosts round-trip with brackets', () => {
    assert.equal(normalizeOrigin('http://[::1]:5173'), 'http://[::1]:5173');
    assert.equal(normalizeOrigin('http://[::1]'), 'http://[::1]');
  });

  it('throws on non-string input', () => {
    // @ts-ignore — deliberately wrong type
    assert.throws(() => normalizeOrigin(null), OriginNormalizationError);
    // @ts-ignore
    assert.throws(() => normalizeOrigin(undefined), OriginNormalizationError);
  });
});

describe('isLoopbackOrigin', () => {
  it('recognizes localhost/127.0.0.1/[::1] with any port', () => {
    assert.equal(isLoopbackOrigin('http://localhost'), true);
    assert.equal(isLoopbackOrigin('http://localhost:5173'), true);
    assert.equal(isLoopbackOrigin('https://localhost:8443'), true);
    assert.equal(isLoopbackOrigin('http://127.0.0.1:9999'), true);
    assert.equal(isLoopbackOrigin('http://[::1]:5173'), true);
  });

  it('rejects non-loopback hosts even with localhost-looking names', () => {
    assert.equal(isLoopbackOrigin('https://example.com'), false);
    assert.equal(isLoopbackOrigin('https://foo.localhost'), false);
    assert.equal(isLoopbackOrigin('https://localhost.evil.com'), false);
  });
});

describe('checkOrigin', () => {
  it('accepts matching exact-bound origin', () => {
    const r = checkOrigin('https://push.zen-dev.com', 'https://push.zen-dev.com');
    assert.equal(r.ok, true);
  });

  it('accepts matching exact-bound origin with case differences', () => {
    const r = checkOrigin('HTTPS://Push.Zen-Dev.com', 'https://push.zen-dev.com');
    assert.equal(r.ok, true);
  });

  it('rejects wrong origin against exact-bound token', () => {
    const r = checkOrigin('https://evil.example', 'https://push.zen-dev.com');
    assert.equal(r.ok, false);
  });

  it('rejects loopback origin against exact-bound token', () => {
    const r = checkOrigin('http://localhost:5173', 'https://push.zen-dev.com');
    assert.equal(r.ok, false);
  });

  it('accepts loopback origin against loopback-bound token', () => {
    const r = checkOrigin('http://localhost:5173', 'loopback');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.normalized, 'http://localhost:5173');
  });

  it('rejects non-loopback origin against loopback-bound token', () => {
    const r = checkOrigin('https://push.zen-dev.com', 'loopback');
    assert.equal(r.ok, false);
  });

  it('rejects Origin: null', () => {
    assert.equal(checkOrigin('null', 'loopback').ok, false);
    assert.equal(checkOrigin('null', 'https://push.zen-dev.com').ok, false);
  });

  it('rejects missing Origin', () => {
    assert.equal(checkOrigin(undefined, 'loopback').ok, false);
    assert.equal(checkOrigin(null, 'https://push.zen-dev.com').ok, false);
  });

  it('rejection reasons never echo token material', () => {
    // Sanity check — none of the reasons we produce contain bearer-like
    // strings. The token "pushd_..." prefix is the search target.
    const cases = [
      checkOrigin(undefined, 'loopback'),
      checkOrigin('null', 'loopback'),
      checkOrigin('https://evil.example', 'https://push.zen-dev.com'),
      checkOrigin('http://localhost', 'https://push.zen-dev.com'),
      checkOrigin('ws://example.com', 'loopback'),
    ];
    for (const r of cases) {
      assert.equal(r.ok, false);
      assert.ok(
        !r.reason.includes('pushd_'),
        `reason should not include token prefix: ${r.reason}`,
      );
    }
  });
});
