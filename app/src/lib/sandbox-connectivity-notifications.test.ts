import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SANDBOX_CONNECTIVITY_TOAST_ID,
  getSandboxConnectivityToast,
} from './sandbox-connectivity-notifications';

describe('getSandboxConnectivityToast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs reconnect transitions without showing notifications', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(getSandboxConnectivityToast('idle', 'reconnecting', null, null)).toBeNull();
    expect(getSandboxConnectivityToast('reconnecting', 'ready', null, null)).toBeNull();

    expect(log).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        level: 'info',
        event: 'sandbox_reconnecting',
        previousStatus: 'idle',
        nextStatus: 'reconnecting',
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        level: 'info',
        event: 'sandbox_reconnected',
        previousStatus: 'reconnecting',
        nextStatus: 'ready',
      }),
    );
  });

  it('keeps reconnect fallback to idle quiet because tools can cold-start on demand', () => {
    expect(getSandboxConnectivityToast('reconnecting', 'idle', null, null)).toBeNull();
  });

  it('keeps ready to idle quiet because tools can cold-start on demand', () => {
    expect(getSandboxConnectivityToast('ready', 'idle', null, null)).toBeNull();
  });

  it('announces an error even when the error message arrives after the status change', () => {
    expect(getSandboxConnectivityToast('error', 'error', 'connection refused', null)).toEqual({
      kind: 'error',
      message: 'Sandbox needs attention',
      options: {
        id: SANDBOX_CONNECTIVITY_TOAST_ID,
        description: 'Open the workspace status for retry and restart options.',
      },
    });
  });

  it('does not repeat the same error notification on unchanged error renders', () => {
    expect(
      getSandboxConnectivityToast('error', 'error', 'connection refused', 'connection refused'),
    ).toBeNull();
  });
});
