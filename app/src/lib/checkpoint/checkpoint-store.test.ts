import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNativeCheckpointsEnabled, nativeCheckpointsActive } from './checkpoint-store';

const platform = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false) }));
vi.mock('../platform', () => platform);

// Exercises the VITE_NATIVE_CHECKPOINTS flag parser via the process.env path
// (vitest's stubEnv), mirroring relay-binding.test.ts. The import.meta.env
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

// The "you're on native checkpoints, so you're not on cloud snapshots" predicate
// — native shell AND flag, both required. Drives every cloud-snapshot gate in
// useSandbox and the hub affordance hiding (Increment 2).
describe('nativeCheckpointsActive', () => {
  const setNative = (on: boolean) => platform.isNativePlatform.mockReturnValue(on);
  afterEach(() => {
    vi.unstubAllEnvs();
    platform.isNativePlatform.mockReturnValue(false);
  });

  it('is true only when both native shell and flag are on', () => {
    setNative(true);
    vi.stubEnv('VITE_NATIVE_CHECKPOINTS', '1');
    expect(nativeCheckpointsActive()).toBe(true);
  });

  it('is false on the native shell when the flag is off', () => {
    setNative(true);
    expect(nativeCheckpointsActive()).toBe(false);
  });

  it('is false off the native shell even when the flag is on', () => {
    setNative(false);
    vi.stubEnv('VITE_NATIVE_CHECKPOINTS', '1');
    expect(nativeCheckpointsActive()).toBe(false);
  });
});
