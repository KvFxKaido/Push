/**
 * local-pc-binding.test.ts — Unit coverage for the small pure
 * helpers in `local-pc-binding.ts`. The hook + adapter integration
 * is exercised in `local-daemon-binding.test.ts` (adapter) and the
 * pairing component test (UI).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_PC_HOST,
  isLocalPcModeEnabled,
  isLocalPcSession,
  isValidPort,
} from './local-pc-binding';
import type { WorkspaceSession } from '@/types';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isValidPort', () => {
  it.each([
    ['1', true],
    ['80', true],
    ['8080', true],
    ['65535', true],
    ['  443  ', true],
  ])('accepts %s', (input, expected) => {
    expect(isValidPort(input)).toBe(expected);
  });

  it.each([
    ['0', false],
    ['65536', false],
    ['-1', false],
    ['abc', false],
    ['12a', false],
    ['', false],
    ['1.5', false],
    ['100000', false],
  ])('rejects %s', (input, expected) => {
    expect(isValidPort(input)).toBe(expected);
  });
});

describe('isLocalPcModeEnabled', () => {
  it('is OFF when the flag is empty', () => {
    vi.stubEnv('VITE_LOCAL_PC_MODE', '');
    expect(isLocalPcModeEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('treats %s as enabled', (raw) => {
    vi.stubEnv('VITE_LOCAL_PC_MODE', raw);
    expect(isLocalPcModeEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off', 'nope'])('treats %s as disabled', (raw) => {
    vi.stubEnv('VITE_LOCAL_PC_MODE', raw);
    expect(isLocalPcModeEnabled()).toBe(false);
  });
});

describe('isLocalPcSession', () => {
  it('narrows local-pc sessions to expose the binding', () => {
    const session: WorkspaceSession = {
      id: 'w-1',
      kind: 'local-pc',
      binding: { port: 4242, token: 't', boundOrigin: 'http://localhost:5173' },
      sandboxId: null,
    };
    expect(isLocalPcSession(session)).toBe(true);
    if (isLocalPcSession(session)) {
      // Type narrowed — binding accessible without optional chain.
      expect(session.binding.port).toBe(4242);
    }
  });

  it('returns false for other kinds', () => {
    const scratch: WorkspaceSession = { id: 'w-2', kind: 'scratch', sandboxId: null };
    const chat: WorkspaceSession = { id: 'w-3', kind: 'chat', sandboxId: null };
    expect(isLocalPcSession(scratch)).toBe(false);
    expect(isLocalPcSession(chat)).toBe(false);
  });
});

describe('LOCAL_PC_HOST', () => {
  it('is the IPv4 loopback literal', () => {
    // The adapter refuses non-loopback hosts; pinning the constant
    // makes drift loud if a future refactor changes the default.
    expect(LOCAL_PC_HOST).toBe('127.0.0.1');
  });
});
