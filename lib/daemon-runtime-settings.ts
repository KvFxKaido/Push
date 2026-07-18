/**
 * Shared daemon runtime setting vocabulary.
 *
 * The web UI presents approval modes in user-facing terms, while the CLI daemon
 * executes with `PUSH_EXEC_MODE` terms. Keep those controls and the shared
 * sandbox/search vocabularies explicit so Remote, the TUI, and pushd do not drift.
 */

export type DaemonExecMode = 'strict' | 'auto' | 'yolo';
export type DaemonApprovalMode = 'supervised' | 'autonomous' | 'full-auto';
export type DaemonWebSearchBackend = 'auto' | 'tavily' | 'ollama' | 'duckduckgo';
export type DaemonSandboxBackend = 'host' | 'docker' | 'native';

export const DAEMON_EXEC_MODES = ['strict', 'auto', 'yolo'] as const;
export const DAEMON_APPROVAL_MODES = ['supervised', 'autonomous', 'full-auto'] as const;
export const DAEMON_WEB_SEARCH_BACKENDS = ['auto', 'tavily', 'ollama', 'duckduckgo'] as const;
export const DAEMON_SANDBOX_BACKENDS = ['host', 'docker', 'native'] as const;

export function isDaemonExecMode(value: unknown): value is DaemonExecMode {
  return typeof value === 'string' && (DAEMON_EXEC_MODES as readonly string[]).includes(value);
}

export function isDaemonApprovalMode(value: unknown): value is DaemonApprovalMode {
  return typeof value === 'string' && (DAEMON_APPROVAL_MODES as readonly string[]).includes(value);
}

export function isDaemonWebSearchBackend(value: unknown): value is DaemonWebSearchBackend {
  return (
    typeof value === 'string' && (DAEMON_WEB_SEARCH_BACKENDS as readonly string[]).includes(value)
  );
}

export function isDaemonSandboxBackend(value: unknown): value is DaemonSandboxBackend {
  return (
    typeof value === 'string' && (DAEMON_SANDBOX_BACKENDS as readonly string[]).includes(value)
  );
}

export function normalizeDaemonExecMode(value: unknown): DaemonExecMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isDaemonExecMode(normalized) ? normalized : null;
}

export function normalizeDaemonWebSearchBackend(value: unknown): DaemonWebSearchBackend | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isDaemonWebSearchBackend(normalized) ? normalized : null;
}

export function normalizeDaemonSandboxBackend(value: unknown): DaemonSandboxBackend | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return isDaemonSandboxBackend(normalized) ? normalized : null;
}

export function daemonExecModeToApprovalMode(mode: DaemonExecMode): DaemonApprovalMode {
  switch (mode) {
    case 'strict':
      return 'supervised';
    case 'auto':
      return 'autonomous';
    case 'yolo':
      return 'full-auto';
  }
}

export function approvalModeToDaemonExecMode(mode: DaemonApprovalMode): DaemonExecMode {
  switch (mode) {
    case 'supervised':
      return 'strict';
    case 'autonomous':
      return 'auto';
    case 'full-auto':
      return 'yolo';
  }
}
