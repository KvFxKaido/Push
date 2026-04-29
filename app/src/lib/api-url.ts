// Resolves API URLs for fetch calls so the same client code works on both web
// and mobile. On web, paths stay relative — Cloudflare serves the Worker and
// the static SPA from the same origin. Inside the Capacitor WebView the SPA
// origin is `https://localhost`, so relative paths resolve to a non-existent
// server and the WebView falls back to the bundled index.html (HTML where the
// caller expected JSON). When running natively, prepend VITE_API_BASE_URL.
//
// Detect Capacitor at runtime via window.Capacitor instead of importing
// @capacitor/core — keeps this module safe to land in the Worker bundle via
// transitive imports without dragging the Capacitor SDK into it.

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

type CapacitorGlobal = { isNativePlatform?: () => boolean };

function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() ?? false;
}

export function resolveApiUrl(path: string): string {
  if (!isCapacitorNative() || !API_BASE) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
