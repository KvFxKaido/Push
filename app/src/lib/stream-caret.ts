/**
 * Streaming caret style — the trailing indicator shown at the end of an
 * assistant reply while it streams (legacy, non-Streamdown render path).
 *
 * - `pill` (default): the original accent capsule that breathes opacity.
 * - `hexagon`: a tiny Push hexagon that pulses, echoing the streaming avatar
 *   so the two read as one system.
 *
 * A comparison switch while we settle on a favorite — flip it at runtime with
 * `?caret=pill|hexagon` in the URL or `localStorage['push:caret']`, no rebuild.
 * Mirrors the `resolveNavMode` pattern in `lib/nav-transition.ts`.
 */
export type StreamCaretStyle = 'pill' | 'hexagon';

export const STREAM_CARET_DEFAULT: StreamCaretStyle = 'pill';

function isStreamCaretStyle(value: string | null): value is StreamCaretStyle {
  return value === 'pill' || value === 'hexagon';
}

export function resolveStreamCaret(): StreamCaretStyle {
  if (typeof window === 'undefined') return STREAM_CARET_DEFAULT;
  try {
    // Bare URL key (`caret`) but namespaced storage key (`push:caret`) — the
    // same split `resolveNavMode` uses (`?nav=` + `push:navMode`): the query
    // param is a transient, easily-typed override while the localStorage key is
    // shared global state that wants the `push:` namespace.
    const fromUrl = new URLSearchParams(window.location.search).get('caret');
    if (isStreamCaretStyle(fromUrl)) return fromUrl;
    const fromStore = window.localStorage.getItem('push:caret');
    if (isStreamCaretStyle(fromStore)) return fromStore;
  } catch {
    // SSR / blocked storage / malformed URL — fall back to the default.
  }
  return STREAM_CARET_DEFAULT;
}
