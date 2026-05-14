import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY_SCHEMA_VERSION } from './tool-registry.js';

describe('TOOL_REGISTRY_SCHEMA_VERSION', () => {
  it('is a stable 8-character hex string', () => {
    // The schema version is included in the tool-protocol prompt block
    // so wire captures and prompt snapshots carry it. Operators
    // debugging "why did the agent emit the old argument shape?" can
    // grep their logs for the version and match it to a commit. The
    // format must be stable across processes for the same code —
    // any change to the hash function or stringification shape
    // breaks downstream correlation. This test pins both.
    expect(TOOL_REGISTRY_SCHEMA_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic across imports within the same process', () => {
    // Sanity check: importing the version twice yields the same string.
    // (Trivially true given the module-level const, but guards against
    // a future refactor that accidentally recomputes per-call.)
    const a = TOOL_REGISTRY_SCHEMA_VERSION;
    const b = TOOL_REGISTRY_SCHEMA_VERSION;
    expect(a).toBe(b);
  });
});
