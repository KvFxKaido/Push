import type { SandboxStatus } from '@/hooks/useSandbox';

export const SANDBOX_CONNECTIVITY_TOAST_ID = 'sandbox-connectivity';

export type SandboxConnectivityToast = {
  kind: 'info' | 'success' | 'error';
  message: string;
  options: {
    id: string;
    description?: string;
  };
};

export function getSandboxConnectivityToast(
  previousStatus: SandboxStatus,
  nextStatus: SandboxStatus,
  error: string | null,
  previousError: string | null,
): SandboxConnectivityToast | null {
  if (
    nextStatus === 'error' &&
    error &&
    (previousStatus !== nextStatus || previousError !== error)
  ) {
    return {
      kind: 'error',
      message: 'Sandbox needs attention',
      options: {
        id: SANDBOX_CONNECTIVITY_TOAST_ID,
        description: 'Open the workspace status for retry and restart options.',
      },
    };
  }

  if (previousStatus === nextStatus) return null;

  if (nextStatus === 'reconnecting') {
    return {
      kind: 'info',
      message: 'Reconnecting to sandbox...',
      options: { id: SANDBOX_CONNECTIVITY_TOAST_ID },
    };
  }

  if (nextStatus === 'ready') {
    if (previousStatus === 'reconnecting') {
      return {
        kind: 'success',
        message: 'Sandbox reconnected',
        options: { id: SANDBOX_CONNECTIVITY_TOAST_ID },
      };
    }
    if (previousStatus === 'creating') {
      return {
        kind: 'success',
        message: 'Sandbox ready',
        options: { id: SANDBOX_CONNECTIVITY_TOAST_ID },
      };
    }
    return null;
  }

  if (nextStatus === 'idle') {
    if (previousStatus === 'reconnecting') {
      return null;
    }
    if (previousStatus === 'ready') {
      return {
        kind: 'info',
        message: 'Sandbox idle. Code tools will start it again when needed.',
        options: { id: SANDBOX_CONNECTIVITY_TOAST_ID },
      };
    }
  }

  return null;
}
