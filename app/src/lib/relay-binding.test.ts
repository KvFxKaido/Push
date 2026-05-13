/**
 * Tests for `relay-binding.ts` (Phase 2.f).
 *
 * Bundle decode parity with the CLI: the encoder lives in
 * `cli/pushd-relay-pair-bundle.ts` and the decoder lives here. Both
 * must agree byte-for-byte so a bundle printed by `push daemon pair
 * --remote` decodes cleanly in the web pairing panel. The CLI test
 * file pins the encoder; this one pins the decoder + cross-checks a
 * known-good string.
 */
import { describe, expect, it } from 'vitest';
import {
  isRelayModeEnabled,
  isRelaySession,
  parseRemotePairBundle,
  __test__,
} from './relay-binding';
import type { WorkspaceSession } from '@/types';

const VALID_INPUT = {
  deploymentUrl: 'https://relay.example/api',
  sessionId: 'pushd-host.local',
  token: 'pushd_da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

function makeBundle(input: typeof VALID_INPUT): string {
  // Browser-safe base64url encode without Node's Buffer.
  const json = JSON.stringify({ v: __test__.PAIR_BUNDLE_VERSION, ...input });
  const utf8 = new TextEncoder().encode(json);
  let bin = '';
  for (const b of utf8) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${__test__.PAIR_BUNDLE_PREFIX}${b64}`;
}

describe('isRelayModeEnabled', () => {
  it('reads VITE_RELAY_MODE from process.env', () => {
    const original = process.env.VITE_RELAY_MODE;
    try {
      process.env.VITE_RELAY_MODE = '1';
      expect(isRelayModeEnabled()).toBe(true);
      process.env.VITE_RELAY_MODE = 'true';
      expect(isRelayModeEnabled()).toBe(true);
      process.env.VITE_RELAY_MODE = '0';
      expect(isRelayModeEnabled()).toBe(false);
      delete process.env.VITE_RELAY_MODE;
      expect(isRelayModeEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.VITE_RELAY_MODE;
      else process.env.VITE_RELAY_MODE = original;
    }
  });
});

describe('isRelaySession', () => {
  it('narrows the kind:"relay" arm', () => {
    const relay: WorkspaceSession = {
      id: 'x',
      kind: 'relay',
      binding: { deploymentUrl: 'https://x', sessionId: 's', token: 'pushd_da_xxx' },
      sandboxId: null,
    };
    expect(isRelaySession(relay)).toBe(true);
    if (isRelaySession(relay)) {
      expect(relay.binding.deploymentUrl).toBe('https://x');
    }
  });
  it('rejects other kinds', () => {
    const scratch: WorkspaceSession = { id: 'x', kind: 'scratch', sandboxId: null };
    const localPc: WorkspaceSession = {
      id: 'x',
      kind: 'local-pc',
      binding: { port: 1, token: 'pushd_xxx', boundOrigin: 'loopback' },
      sandboxId: null,
    };
    expect(isRelaySession(scratch)).toBe(false);
    expect(isRelaySession(localPc)).toBe(false);
  });
});

describe('parseRemotePairBundle', () => {
  it('roundtrips a CLI-shaped bundle', () => {
    const bundle = makeBundle(VALID_INPUT);
    expect(parseRemotePairBundle(bundle)).toEqual(VALID_INPUT);
  });

  it('tolerates surrounding whitespace (terminal paste)', () => {
    const bundle = makeBundle(VALID_INPUT);
    expect(parseRemotePairBundle(`  ${bundle}  \n`)).toEqual(VALID_INPUT);
  });

  it('returns null for non-bundle strings', () => {
    expect(parseRemotePairBundle('')).toBeNull();
    expect(parseRemotePairBundle('not-a-bundle')).toBeNull();
    expect(parseRemotePairBundle(__test__.PAIR_BUNDLE_PREFIX)).toBeNull();
  });

  it('returns null when token prefix is not pushd_da_', () => {
    const bad = makeBundle({ ...VALID_INPUT, token: 'pushd_relay_xxxx' });
    expect(parseRemotePairBundle(bad)).toBeNull();
  });

  it('returns null for wrong bundle version', () => {
    const json = JSON.stringify({ v: 99, ...VALID_INPUT });
    const utf8 = new TextEncoder().encode(json);
    let bin = '';
    for (const b of utf8) bin += String.fromCharCode(b);
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseRemotePairBundle(`${__test__.PAIR_BUNDLE_PREFIX}${b64}`)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const json = JSON.stringify({
      v: __test__.PAIR_BUNDLE_VERSION,
      deploymentUrl: VALID_INPUT.deploymentUrl,
      token: VALID_INPUT.token,
      // sessionId missing
    });
    const utf8 = new TextEncoder().encode(json);
    let bin = '';
    for (const b of utf8) bin += String.fromCharCode(b);
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseRemotePairBundle(`${__test__.PAIR_BUNDLE_PREFIX}${b64}`)).toBeNull();
  });
});
