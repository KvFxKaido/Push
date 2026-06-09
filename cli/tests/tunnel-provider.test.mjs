/**
 * Unit tests for the TunnelProvider name resolver.
 *
 * Pins the PUSH_TUNNEL_PROVIDER resolution contract: an explicit option wins,
 * the env var is trimmed/lowercased and validated against the canonical name
 * list, and anything unknown falls back to the default. Behavior-only — the
 * rest of `lib/tunnel-provider.ts` is types.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTunnelProviderName,
  DEFAULT_TUNNEL_PROVIDER,
  TUNNEL_PROVIDER_NAMES,
} from '../../lib/tunnel-provider.ts';

describe('resolveTunnelProviderName', () => {
  const KEY = 'PUSH_TUNNEL_PROVIDER';
  let original;

  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to cf-sandbox-proxy when nothing is set', () => {
    assert.equal(resolveTunnelProviderName(), 'cf-sandbox-proxy');
    assert.equal(DEFAULT_TUNNEL_PROVIDER, 'cf-sandbox-proxy');
  });

  it('prefers an explicit provider option over the env var', () => {
    process.env[KEY] = 'modal-endpoint';
    assert.equal(resolveTunnelProviderName({ provider: 'relay' }), 'relay');
  });

  it('resolves a valid env var', () => {
    process.env[KEY] = 'cloudflared';
    assert.equal(resolveTunnelProviderName(), 'cloudflared');
  });

  it('trims and lowercases the env var', () => {
    process.env[KEY] = '  CLOUDFLARED  ';
    assert.equal(resolveTunnelProviderName(), 'cloudflared');
  });

  it('falls back to the default on an unknown env value', () => {
    process.env[KEY] = 'ngrok';
    assert.equal(resolveTunnelProviderName(), DEFAULT_TUNNEL_PROVIDER);
  });

  it('accepts every canonical provider name', () => {
    for (const name of TUNNEL_PROVIDER_NAMES) {
      process.env[KEY] = name;
      assert.equal(resolveTunnelProviderName(), name);
    }
  });
});
