import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNativeCheckpointsEnabled } from './checkpoint-store';

// Exercises the VITE_NATIVE_CHECKPOINTS flag parser via the process.env path
// (vitest's stubEnv), mirroring local-pc-binding.test.ts. The import.meta.env
// branch is Vite-inlined at build time and not reachable under the test runtime.
describe('isNativeCheckpointsEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is OFF when the flag is unset', () => {
    expect(isNativeCheckpointsEnabled()).toBe(false);
  });

  it('is OFF when the flag is empty', () => {
    vi.stubEnv('VITE_NATIVE_CHECKPOINTS', '');
    expect(isNativeCheckpointsEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' On '])('treats %j as enabled', (raw) => {
    vi.stubEnv('VITE_NATIVE_CHECKPOINTS', raw);
    expect(isNativeCheckpointsEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'nope', 'enabled?'])('treats %j as disabled', (raw) => {
    vi.stubEnv('VITE_NATIVE_CHECKPOINTS', raw);
    expect(isNativeCheckpointsEnabled()).toBe(false);
  });
});
