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
