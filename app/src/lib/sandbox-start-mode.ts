export type SandboxStartMode = 'off' | 'smart' | 'always';

const SANDBOX_START_MODE_KEY = 'push_sandbox_start_mode';

export function getSandboxStartMode(): SandboxStartMode {
  try {
    const stored = localStorage.getItem(SANDBOX_START_MODE_KEY);
    if (stored === 'off' || stored === 'smart' || stored === 'always') {
      return stored;
    }
  } catch {
    // ignore storage errors
  }
  return 'off';
}

export function setSandboxStartMode(mode: SandboxStartMode): void {
  try {
    localStorage.setItem(SANDBOX_START_MODE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}
