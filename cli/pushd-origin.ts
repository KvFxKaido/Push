/**
 * pushd-origin.ts — Origin normalization and matching for the pushd WS
 * pairing flow.
 *
 * Policy: tokens minted by `push daemon pair` are bound to exactly one
 * origin at mint time — either the sentinel "loopback" (any port on
 * localhost / 127.0.0.1 / [::1]) or one specific normalized non-loopback
 * origin. The WS upgrade handler calls `checkOrigin(headerValue, bound)`
 * and refuses the upgrade if it returns `ok: false`.
 *
 * Failure messages here are safe to surface in upgrade-rejection logs;
 * they never echo token material. Never include the received token in
 * any string this module returns.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type NormalizedOrigin = string;

export class OriginNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OriginNormalizationError';
  }
}

/**
 * Normalize an origin per the pairing policy:
 *  - http: or https: only
 *  - lowercase scheme + host (URL parsing lowercases hostnames already;
 *    .toLowerCase() is belt-and-suspenders for the scheme)
 *  - strip path, query, hash, trailing slash
 *  - preserve non-default port (URL elides the default port automatically,
 *    matching the Origin header a browser would send)
 *  - reject userinfo (user:pass@host)
 *
 * Throws OriginNormalizationError on any invalid input.
 */
export function normalizeOrigin(input: string): NormalizedOrigin {
  if (typeof input !== 'string' || input.length === 0) {
    throw new OriginNormalizationError('Origin must be a non-empty string');
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginNormalizationError('Cannot parse origin');
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new OriginNormalizationError(
      `Only http and https origins are allowed; got "${url.protocol.replace(/:$/, '')}"`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new OriginNormalizationError('Origin must not include user/password');
  }

  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    throw new OriginNormalizationError('Origin must have a host');
  }

  // url.port is '' for default-or-missing ports — matches the Origin header
  // a browser would send (e.g. https://example.com without :443).
  const portSuffix = url.port ? `:${url.port}` : '';

  // Node's URL.hostname keeps IPv6 brackets (e.g. "[::1]") — leave that
  // form intact for unambiguous comparison, and wrap bare IPv6 strings
  // (no brackets) defensively.
  const hostFormatted = host.startsWith('[') || !host.includes(':') ? host : `[${host}]`;

  return `${scheme}//${hostFormatted}${portSuffix}`;
}

/**
 * True iff `origin` is loopback (localhost / 127.0.0.1 / [::1]) with any
 * port. Caller must pass a value already produced by `normalizeOrigin`;
 * this function does not normalize.
 *
 * Arbitrary `*.localhost` is intentionally NOT matched in PR 1 — see the
 * Sandbox Policy decision doc and the PR description for the rationale.
 */
export function isLoopbackOrigin(origin: NormalizedOrigin): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

export type OriginCheckResult =
  | { ok: true; normalized: NormalizedOrigin }
  | { ok: false; reason: string };

/**
 * Decide whether a WS-upgrade Origin header is acceptable for a token
 * with the given `boundOrigin`. Fail-closed: missing Origin, `Origin:
 * null`, or any normalization error is a rejection.
 *
 * Browsers always send Origin on WS upgrades; PR 1 supports browser dev
 * + explicit web pairing only, so non-browser clients without Origin
 * headers are out of scope and rejected by design.
 *
 * The returned `reason` is safe to log and to surface back to the
 * client in the upgrade rejection — it never contains token material.
 */
export function checkOrigin(
  rawOrigin: string | undefined | null,
  boundOrigin: 'loopback' | NormalizedOrigin,
): OriginCheckResult {
  if (rawOrigin == null) {
    return {
      ok: false,
      reason:
        boundOrigin === 'loopback' ? 'Origin required.' : 'Origin required for non-loopback token.',
    };
  }
  if (rawOrigin === 'null') {
    return { ok: false, reason: 'Origin "null" is not permitted.' };
  }

  let normalized: NormalizedOrigin;
  try {
    normalized = normalizeOrigin(rawOrigin);
  } catch (err) {
    const detail = err instanceof OriginNormalizationError ? err.message : 'invalid origin';
    return { ok: false, reason: detail };
  }

  if (boundOrigin === 'loopback') {
    if (isLoopbackOrigin(normalized)) return { ok: true, normalized };
    return { ok: false, reason: 'Token is loopback-only.' };
  }

  if (normalized !== boundOrigin) {
    return { ok: false, reason: 'Origin does not match the origin bound to this token.' };
  }
  return { ok: true, normalized };
}
