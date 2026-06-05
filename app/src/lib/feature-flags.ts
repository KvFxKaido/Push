/**
 * Feature flags for the Push web app.
 *
 * Flags are build-time opt-in via Vite env vars (`VITE_*`), with an optional
 * `localStorage` override so QA / dev can toggle without a rebuild. Default is
 * always the conservative (off) state when neither is set.
 */

function readBuildFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function readLocalOverride(key: string): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.localStorage?.getItem(key);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  } catch {
    // Private mode / disabled storage — fall through to the build flag.
  }
  return undefined;
}

/**
 * Render assistant markdown with the Streamdown adapter
 * (`PushMarkdownRenderer`) instead of the legacy `formatContent` parser.
 *
 * - Build flag: `VITE_USE_STREAMDOWN=1`
 * - Runtime override: `localStorage['push:streamdown'] = '1' | '0'`
 *
 * Off by default. Read at render time so the localStorage override takes effect
 * without a reload.
 */
export function isStreamdownEnabled(): boolean {
  const override = readLocalOverride('push:streamdown');
  if (override !== undefined) return override;
  return readBuildFlag(import.meta.env.VITE_USE_STREAMDOWN as string | undefined);
}
