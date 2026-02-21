function readBoolFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** Tri-state: true = force on, false = force off, undefined = use provider default */
function readTriStateFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  return undefined;
}

export const browserToolEnabled = readBoolFlag(import.meta.env.VITE_BROWSER_TOOL_ENABLED);

/**
 * Override for native function calling.
 * Set VITE_NATIVE_FC=0 to force prompt-engineered fallback for all providers.
 * Set VITE_NATIVE_FC=1 to force native FC for all providers.
 * Unset: use per-provider default (Ollama=off, Mistral/OpenRouter=on).
 */
export const nativeFCOverride = readTriStateFlag(import.meta.env.VITE_NATIVE_FC);
