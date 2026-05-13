/**
 * relay-binding.ts — Helpers for the Remote (relay) workspace mode.
 * Phase 2.f sibling to `local-pc-binding.ts`.
 *
 * The `RelayBinding` type lives in `@/types` next to `LocalPcBinding`
 * so the workspace-session union shape stays one read away. This
 * module holds the feature flag, the pair-bundle decoder, and the
 * `WorkspaceSession` type guard.
 */
import type { RelayBinding, WorkspaceSession } from '@/types';

const PAIR_BUNDLE_PREFIX = 'push-remote.';
const PAIR_BUNDLE_VERSION = 1 as const;
const ATTACH_TOKEN_PREFIX = 'pushd_da_';

/**
 * Feature flag for the Remote entry point. Hub tile + route screen
 * gate on this. Defaults OFF so the experimental path doesn't leak
 * into mainline builds. Reads `process.env` first (vitest /
 * `stubEnv`) then `import.meta.env` (Vite inline) — same shape as
 * `isLocalPcModeEnabled`.
 */
export function isRelayModeEnabled(): boolean {
  const raw = readFlag();
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readFlag(): string | boolean | undefined {
  if (typeof process !== 'undefined' && process.env?.VITE_RELAY_MODE !== undefined) {
    return process.env.VITE_RELAY_MODE;
  }
  const meta = (import.meta as ImportMeta & { env?: { VITE_RELAY_MODE?: string | boolean } }).env;
  return meta?.VITE_RELAY_MODE;
}

/**
 * Type guard for the relay arm of `WorkspaceSession`. Mirrors
 * `isLocalPcSession` so call sites narrowing before reading `.binding`
 * keep the transport boundary obvious.
 */
export function isRelaySession(
  session: WorkspaceSession,
): session is Extract<WorkspaceSession, { kind: 'relay' }> {
  return session.kind === 'relay';
}

/**
 * Decode a pair bundle string emitted by `push daemon pair --remote`.
 * Returns the constituent `RelayBinding` fields, or null for ANY
 * malformed input (wrong prefix, bad base64url, non-JSON, missing
 * fields, wrong version, wrong token shape). The paste panel calls
 * this and surfaces a generic "not a valid bundle" message — leaking
 * which specific check failed would help nothing and hurt nobody
 * except the user trying to copy-paste cleanly.
 *
 * Mirrors `cli/pushd-relay-pair-bundle.ts` decode in both shape and
 * permissiveness; a drift test pins the two against each other.
 */
export function parseRemotePairBundle(
  raw: string,
): Pick<
  RelayBinding,
  'deploymentUrl' | 'sessionId' | 'token' | 'attachTokenId' | 'deviceTokenId'
> | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(PAIR_BUNDLE_PREFIX)) return null;
  const body = trimmed.slice(PAIR_BUNDLE_PREFIX.length);
  if (body.length === 0) return null;
  // Browser-safe base64url → string: replace url-safe chars, pad,
  // then atob. Going through atob keeps the bundle decode pure
  // browser code (no Node Buffer in the web bundle).
  let json: string;
  try {
    json = b64urlDecode(body);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== PAIR_BUNDLE_VERSION
  ) {
    return null;
  }
  const obj = parsed as {
    deploymentUrl?: unknown;
    sessionId?: unknown;
    token?: unknown;
    attachTokenId?: unknown;
    deviceTokenId?: unknown;
  };
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

function b64urlDecode(input: string): string {
  // Convert URL-safe base64 to standard base64 + pad.
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  const decoded = atob(standard + pad);
  // atob → binary string; for UTF-8 JSON we need to re-encode through
  // a TextDecoder so multi-byte chars survive. JSON typically lands
  // in ASCII for our case (URLs, hex tokens), but the round-trip
  // shouldn't silently corrupt extended chars.
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/** Exposed for tests. */
export const __test__ = { PAIR_BUNDLE_PREFIX, PAIR_BUNDLE_VERSION, ATTACH_TOKEN_PREFIX };
