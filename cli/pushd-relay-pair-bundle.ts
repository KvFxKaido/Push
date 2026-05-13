/**
 * pushd-relay-pair-bundle.ts — Encode/decode the single-string pairing
 * bundle a phone pastes into the Remote workspace pairing panel.
 * Phase 2.f.
 *
 * Shape:
 *
 *   push-remote.<base64url(JSON.stringify({ v: 1, deploymentUrl, sessionId, token }))>
 *
 * The `push-remote.` prefix is a visual / structural marker — paste
 * panels can refuse anything that doesn't start with it without
 * decoding, and the prefix can't accidentally match a raw token (which
 * starts with `pushd_da_` or `pushd_`).
 *
 * Token discipline: the bundle is the bearer in transit. It's a one-
 * shot string the operator copies from terminal to phone (usually via
 * iMessage / Signal / a one-time paste). After the phone has dialled
 * the relay and IndexedDB has the record, the bundle string should be
 * discarded. We don't persist the encoded form on the CLI side beyond
 * stdout.
 */

const PREFIX = 'push-remote.';
const BUNDLE_VERSION = 1 as const;
const ATTACH_TOKEN_PREFIX = 'pushd_da_';

export interface RemotePairBundle {
  deploymentUrl: string;
  sessionId: string;
  /** Attach-token bearer (`pushd_da_*`). */
  token: string;
  /**
   * Public attach tokenId (`pdat_*`). Not a secret — the daemon
   * prints it to stdout for revocation guidance and the web pair
   * panel surfaces it in the paired-device row. Optional for
   * back-compat with bundles minted before this field landed.
   */
  attachTokenId?: string;
  /**
   * Parent device tokenId (`pdt_*`) the attach token was bound to.
   * Same posture as `attachTokenId` — public, used for the
   * `push daemon revoke <id>` hint. Optional for back-compat.
   */
  deviceTokenId?: string;
}

/**
 * Encode a bundle. Throws on invalid input; the CLI calls this AFTER
 * minting the underlying attach token, so a malformed input here is
 * a programming error, not user error.
 */
export function encodeRemotePairBundle(input: RemotePairBundle): string {
  if (typeof input.deploymentUrl !== 'string' || input.deploymentUrl.length === 0) {
    throw new Error('deploymentUrl required');
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new Error('sessionId required');
  }
  if (typeof input.token !== 'string' || !input.token.startsWith(ATTACH_TOKEN_PREFIX)) {
    throw new Error(`token must start with ${ATTACH_TOKEN_PREFIX}`);
  }
  const payload = JSON.stringify({
    v: BUNDLE_VERSION,
    deploymentUrl: input.deploymentUrl,
    sessionId: input.sessionId,
    token: input.token,
    ...(input.attachTokenId !== undefined ? { attachTokenId: input.attachTokenId } : {}),
    ...(input.deviceTokenId !== undefined ? { deviceTokenId: input.deviceTokenId } : {}),
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${PREFIX}${encoded}`;
}

/**
 * Decode a bundle. Returns null for ANY malformed input (wrong prefix,
 * non-base64url body, non-JSON payload, missing fields, wrong version,
 * wrong token prefix). The paste UI on the web side calls this; a
 * null return surfaces as "this doesn't look like a push-remote
 * bundle" without leaking which specific check failed.
 */
export function decodeRemotePairBundle(raw: string): RemotePairBundle | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  const body = trimmed.slice(PREFIX.length);
  if (body.length === 0) return null;
  let json: string;
  try {
    json = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== BUNDLE_VERSION) {
    return null;
  }
  const obj = parsed as Partial<RemotePairBundle>;
  if (
    typeof obj.deploymentUrl !== 'string' ||
    obj.deploymentUrl.length === 0 ||
    typeof obj.sessionId !== 'string' ||
    obj.sessionId.length === 0 ||
    typeof obj.token !== 'string' ||
    !obj.token.startsWith(ATTACH_TOKEN_PREFIX)
  ) {
    return null;
  }
  return {
    deploymentUrl: obj.deploymentUrl,
    sessionId: obj.sessionId,
    token: obj.token,
    ...(typeof obj.attachTokenId === 'string' && obj.attachTokenId.length > 0
      ? { attachTokenId: obj.attachTokenId }
      : {}),
    ...(typeof obj.deviceTokenId === 'string' && obj.deviceTokenId.length > 0
      ? { deviceTokenId: obj.deviceTokenId }
      : {}),
  };
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = { PREFIX, BUNDLE_VERSION, ATTACH_TOKEN_PREFIX };
