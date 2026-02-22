function readBoolFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export const browserToolEnabled = readBoolFlag(import.meta.env.VITE_BROWSER_TOOL_ENABLED);
