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
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'sandbox_reconnecting',
        previousStatus,
        nextStatus,
      }),
    );
    return null;
  }

  if (nextStatus === 'ready') {
    if (previousStatus === 'reconnecting') {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'sandbox_reconnected',
          previousStatus,
          nextStatus,
        }),
      );
      return null;
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

  return null;
}
