import { describe, expect, it } from 'vitest';
import { kimiSamplingRule } from './kimi-sampling';

describe('kimiSamplingRule', () => {
  it('omits sampling for kimi-k3 and dated/suffixed k3 ids', () => {
    expect(kimiSamplingRule('kimi-k3')).toEqual({ mode: 'omit' });
    expect(kimiSamplingRule('KIMI-K3')).toEqual({ mode: 'omit' });
    expect(kimiSamplingRule('kimi-k3-0805')).toEqual({ mode: 'omit' });
    expect(kimiSamplingRule('kimi-k3.1')).toEqual({ mode: 'omit' });
  });

  it('pins temperature=1/top_p=0.95 for K2.7 Code, matching the shipped behavior', () => {
    expect(kimiSamplingRule('kimi-k2.7-code')).toEqual({
      mode: 'pinned',
      temperature: 1,
      topP: 0.95,
    });
    expect(kimiSamplingRule('kimi-k2.7-code-highspeed')).toEqual({
      mode: 'pinned',
      temperature: 1,
      topP: 0.95,
    });
  });

  it('returns null for other Kimi models and non-Kimi ids', () => {
    expect(kimiSamplingRule('kimi-k2.6')).toBeNull();
    expect(kimiSamplingRule('kimi-k2.5')).toBeNull();
    // k30 etc. must not match the k3 prefix rule.
    expect(kimiSamplingRule('kimi-k30')).toBeNull();
    // Vendor-prefixed ids are not bare direct-API ids.
    expect(kimiSamplingRule('moonshotai/kimi-k3')).toBeNull();
    expect(kimiSamplingRule('gpt-5.4')).toBeNull();
    expect(kimiSamplingRule('')).toBeNull();
    expect(kimiSamplingRule(undefined)).toBeNull();
  });
});
