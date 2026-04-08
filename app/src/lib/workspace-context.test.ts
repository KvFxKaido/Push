import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSandboxEnvironment = vi.fn();
const mockGetSandboxLifecycleEvents = vi.fn();

vi.mock('./sandbox-client', () => ({
  getSandboxEnvironment: (...args: unknown[]) => mockGetSandboxEnvironment(...args),
  getSandboxLifecycleEvents: (...args: unknown[]) => mockGetSandboxLifecycleEvents(...args),
}));

import { buildSessionCapabilityBlock } from './workspace-context';

describe('buildSessionCapabilityBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T12:00:00.000Z'));
    mockGetSandboxEnvironment.mockReset();
    mockGetSandboxLifecycleEvents.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives remaining TTL from the advertised container TTL', () => {
    mockGetSandboxEnvironment.mockReturnValue({
      tools: { node: 'v20.18.1' },
      container_ttl: '45m',
      writable_root: '/workspace',
    });
    mockGetSandboxLifecycleEvents.mockReturnValue([
      {
        timestamp: Date.parse('2026-04-08T11:20:00.000Z'),
        message: 'Workspace created',
      },
    ]);

    const block = buildSessionCapabilityBlock(
      { mode: 'repo', includeGitHubTools: true },
      true,
    );
    const payload = JSON.parse(block.split('\n').slice(1, -1).join('\n'));

    expect(payload.sandbox.containerTtl).toBe('45m');
    expect(payload.sandbox.containerTtlRemaining).toBe('5m');
  });

  it('renders persisted lifecycle events into the session capability block', () => {
    mockGetSandboxEnvironment.mockReturnValue({
      tools: {},
      container_ttl: '30m',
      writable_root: '/workspace',
    });
    mockGetSandboxLifecycleEvents.mockReturnValue([
      {
        timestamp: Date.parse('2026-04-08T11:30:00.000Z'),
        message: 'Workspace created',
      },
      {
        timestamp: Date.parse('2026-04-08T11:45:00.000Z'),
        message: 'Workspace state restored from snapshot',
      },
    ]);

    const block = buildSessionCapabilityBlock(
      { mode: 'scratch', includeGitHubTools: false },
      true,
    );
    const payload = JSON.parse(block.split('\n').slice(1, -1).join('\n'));

    expect(payload.sandbox.lifecycleEvents).toEqual([
      '[2026-04-08T11:30:00.000Z] Workspace created',
      '[2026-04-08T11:45:00.000Z] Workspace state restored from snapshot',
    ]);
    expect(payload.sandbox.containerTtlRemaining).toBe('0m');
  });
});
