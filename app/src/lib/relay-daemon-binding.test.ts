/**
 * relay-daemon-binding.test.ts — Phase 2.f.
 *
 * The adapter's WS lifetime is exercised through `useRelayDaemon`'s
 * test path; this file pins the pure `buildRelayUrl` helper that
 * #530 review tightened. The two `buildRelayUrl` impls (CLI side +
 * web side) must agree byte-for-byte, since the same operator
 * deployment URL flows through both.
 */
import { describe, expect, it } from 'vitest';
import { buildRelayUrl } from './relay-daemon-binding';

describe('buildRelayUrl (#530 normalization)', () => {
  it('replaces the path on a bare https URL', () => {
    expect(buildRelayUrl('https://example.com', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('replaces an existing /api path prefix (no double-up)', () => {
    expect(buildRelayUrl('https://example.com/api', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('replaces an existing /v1/api path prefix', () => {
    expect(buildRelayUrl('https://example.com/v1/api', 'sess-1')).toBe(
      'wss://example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('rewrites http(s) → ws(s)', () => {
    expect(buildRelayUrl('http://localhost:8787', 'sess-1')).toBe(
      'ws://localhost:8787/api/relay/v1/session/sess-1/connect',
    );
  });

  it('tolerates a bare hostname (defaults to wss)', () => {
    expect(buildRelayUrl('relay.example.com', 'sess-1')).toBe(
      'wss://relay.example.com/api/relay/v1/session/sess-1/connect',
    );
  });

  it('encodes sessionId path component', () => {
    expect(buildRelayUrl('https://example.com', 'pushd-host with spaces')).toMatch(
      /\/session\/pushd-host%20with%20spaces\/connect$/,
    );
  });
});
