/**
 * worker-base64url.ts — shared base64url encoding for Worker-side
 * code. Both `worker-middleware.ts` (Google service-account JWTs)
 * and `relay-do.ts` (phone bearer hashing for the relay allowlist)
 * need the same encoding; keeping multiple implementations risks
 * subtle drift on padding stripping or alphabet replacement that
 * would silently break consumers checking byte-equality (e.g. the
 * allowlist match between pushd's node hash and the DO's WebCrypto
 * hash). One module, one definition.
 */

/** base64url encoding of a UTF-8 string. */
export function base64UrlEncodeString(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** base64url encoding of a raw byte buffer. */
export function base64UrlEncodeBytes(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Restore standard base64 (alphabet + padding) from a base64url string so the
 * platform `atob` can decode it. Padding was stripped on encode; recompute it
 * from the length. Throws (via `atob`) on malformed input — callers that treat
 * decode failure as "invalid token" should wrap in try/catch.
 */
function base64UrlToBase64(value: string): string {
  const restored = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (restored.length % 4)) % 4;
  return restored + '='.repeat(padLength);
}

/** base64url decoding to raw bytes. Inverse of {@link base64UrlEncodeBytes}. */
export function base64UrlDecodeToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64UrlToBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** base64url decoding to a UTF-8 string. Inverse of {@link base64UrlEncodeString}. */
export function base64UrlDecodeToString(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(value));
}
