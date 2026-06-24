import { describe, expect, it } from 'vitest';
import { coerceRepoAppearance, DEFAULT_REPO_APPEARANCE } from './repo-appearance';

describe('coerceRepoAppearance', () => {
  it('returns null for non-object input', () => {
    expect(coerceRepoAppearance(null)).toBeNull();
    expect(coerceRepoAppearance(undefined)).toBeNull();
    expect(coerceRepoAppearance('sky')).toBeNull();
  });

  it('returns null when icon or color is invalid', () => {
    expect(coerceRepoAppearance({ icon: 'nope', color: 'sky' })).toBeNull();
    expect(coerceRepoAppearance({ icon: 'repo-ledger', color: 'chartreuse' })).toBeNull();
  });

  it('defaults glowStyle to gradient for v1 records missing the field', () => {
    // The migration contract: pre-glowStyle records keep the original
    // gradient wash so an upgrade never silently flips a user to dotted.
    const coerced = coerceRepoAppearance({
      icon: 'repo-ledger',
      color: 'sky',
      glowEnabled: true,
    });
    expect(coerced).toEqual({
      icon: 'repo-ledger',
      color: 'sky',
      glowEnabled: true,
      glowStyle: 'gradient',
    });
  });

  it('falls back to gradient when glowStyle is an unknown string', () => {
    const coerced = coerceRepoAppearance({
      icon: 'repo-ledger',
      color: 'sky',
      glowEnabled: true,
      glowStyle: 'sparkles',
    });
    expect(coerced?.glowStyle).toBe('gradient');
  });

  it('preserves a valid dotted glowStyle', () => {
    const coerced = coerceRepoAppearance({
      icon: 'robot-bot',
      color: 'teal',
      glowEnabled: true,
      glowStyle: 'dotted',
    });
    expect(coerced).toEqual({
      icon: 'robot-bot',
      color: 'teal',
      glowEnabled: true,
      glowStyle: 'dotted',
    });
  });

  it('preserves a valid ripple glowStyle', () => {
    const coerced = coerceRepoAppearance({
      icon: 'mobile-slab',
      color: 'indigo',
      glowEnabled: true,
      glowStyle: 'ripple',
    });
    expect(coerced).toEqual({
      icon: 'mobile-slab',
      color: 'indigo',
      glowEnabled: true,
      glowStyle: 'ripple',
    });
  });

  it('defaults glowEnabled to true when missing, independent of glowStyle', () => {
    const coerced = coerceRepoAppearance({ icon: 'repo-ledger', color: 'sky' });
    expect(coerced?.glowEnabled).toBe(true);
    expect(coerced?.glowStyle).toBe('gradient');
  });

  it('round-trips the default appearance unchanged', () => {
    expect(coerceRepoAppearance(DEFAULT_REPO_APPEARANCE)).toEqual(DEFAULT_REPO_APPEARANCE);
  });
});
