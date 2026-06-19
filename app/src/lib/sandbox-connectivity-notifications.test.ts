import { describe, expect, it } from 'vitest';

import {
  SANDBOX_CONNECTIVITY_TOAST_ID,
  getSandboxConnectivityToast,
} from './sandbox-connectivity-notifications';

describe('getSandboxConnectivityToast', () => {
  it('announces a failed reconnect that falls back to idle', () => {
    expect(getSandboxConnectivityToast('reconnecting', 'idle', null, null)).toEqual({
      kind: 'info',
      message: "Couldn't reconnect to the sandbox. Code tools will start a new one when needed.",
      options: { id: SANDBOX_CONNECTIVITY_TOAST_ID },
    });
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
