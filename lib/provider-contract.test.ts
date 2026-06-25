import { describe, expect, it } from 'vitest';
import { EPHEMERAL_CACHE_CONTROL, type CacheControl } from './provider-contract';

/**
 * Drift guard for the centralized prompt-cache marker (#1154 §2). The
 * `cache_control: { type: 'ephemeral' }` literal used to be re-declared inline
 * across the contract types and every serializer; it now lives once here. This
 * pins the wire shape so a change to the single source is a deliberate, reviewed
 * edit — the serializers emit this value verbatim onto the Anthropic/OpenAI wire,
 * so a drift here silently changes prompt caching for every provider.
 */
describe('CacheControl marker', () => {
  it('pins the ephemeral wire shape', () => {
    expect(EPHEMERAL_CACHE_CONTROL).toEqual({ type: 'ephemeral' });
  });

  it('is the single source serializers reference (assignable where CacheControl is expected)', () => {
    const cc: CacheControl = EPHEMERAL_CACHE_CONTROL;
    expect(cc.type).toBe('ephemeral');
  });
});
