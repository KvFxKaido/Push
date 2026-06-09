/**
 * Provider-agnostic tunnel interface.
 *
 * Abstracts exposing a network service — a dev server inside a sandbox, or a
 * port on the host running the CLI daemon — to an authenticated public URL,
 * without coupling Push's runtime contracts to Cloudflare Tunnel (or any one
 * backend). Mirrors the SandboxProvider pattern in `sandbox-provider.ts`:
 * `name` + `capabilities` for runtime feature discovery, lifecycle methods,
 * optional methods gated by capability flags, and provider-agnostic errors.
 *
 * Two distinct concerns share this contract:
 *   - `sandbox-port`: a service inside a managed sandbox (CF / Modal). The
 *     sandbox is already reachable from the Worker, so the "tunnel" is an
 *     authenticated reverse proxy + token mint — see `LivePreviewArtifact` in
 *     `lib/artifacts/types.ts`, which already commits the URL/token shape.
 *   - `local-port`: a service on the user's own machine (where `pushd` runs),
 *     behind NAT, so it needs a real tunnel (cloudflared / ngrok) or can ride
 *     the existing `pushd_relay_*` WebSocket relay as an HTTP channel.
 *
 * This module is contract-only and behavior-free: it carries the types, the
 * error taxonomy, and a pure name resolver. The instantiating factory
 * (`createTunnelProvider`) lands with the first concrete implementation —
 * mirroring how `createSandboxProvider` lives in the provider's impl file, not
 * here — so this file stays browser/Worker-safe (no `process.env` access at
 * import time, no concrete-class imports).
 *
 * Design references:
 *   - Vercel Open Agents Review §5.2: sandbox port exposure / dev-server previews
 *   - lib/artifacts/types.ts: LivePreviewArtifact (committed URL + token shape)
 *   - sandbox-provider.ts: the abstraction pattern this mirrors
 */

// ---------------------------------------------------------------------------
// Provider identity + selection
// ---------------------------------------------------------------------------

/**
 * Supported tunnel backends.
 *
 *   - `cf-sandbox-proxy` — Worker reverse-proxy into a port inside a Cloudflare
 *     sandbox; mints a session-scoped token and serves `preview.<host>`.
 *   - `modal-endpoint`   — Modal's native tunneled web endpoint for a sandbox port.
 *   - `cloudflared`      — local-machine tunnel for the CLI (`push tunnel expose`).
 *   - `relay`            — HTTP multiplexed over the existing pushd relay
 *     (`pushd_relay_*` / RelaySessionDO); local-port exposure with no new DNS.
 *   - `none`             — no tunneling available; `open()` rejects NOT_CONFIGURED.
 */
export type TunnelProviderName =
  | 'cf-sandbox-proxy'
  | 'modal-endpoint'
  | 'cloudflared'
  | 'relay'
  | 'none';

/** Default backend when nothing is configured. */
export const DEFAULT_TUNNEL_PROVIDER: TunnelProviderName = 'cf-sandbox-proxy';

/**
 * Resolve the configured tunnel backend by name (no instantiation).
 *
 * Precedence:
 *   1. Explicit `options.provider` (tests + advanced callers).
 *   2. PUSH_TUNNEL_PROVIDER env var (CLI / Node only — browser/Worker bundles
 *      have no process.env; the guard prevents ReferenceError there).
 *   3. Default: `cf-sandbox-proxy`.
 *
 * Returning a name rather than an instance keeps this contract module free of
 * concrete-class imports. The factory that maps name → instance ships with the
 * first implementation, alongside the Worker preview route.
 */
export function resolveTunnelProviderName(options?: {
  provider?: TunnelProviderName;
}): TunnelProviderName {
  if (options?.provider) return options.provider;
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = (process.env.PUSH_TUNNEL_PROVIDER ?? '').toLowerCase();
      if (
        v === 'cf-sandbox-proxy' ||
        v === 'modal-endpoint' ||
        v === 'cloudflared' ||
        v === 'relay' ||
        v === 'none'
      ) {
        return v;
      }
    }
  } catch {
    // Ignore — fall through to default.
  }
  return DEFAULT_TUNNEL_PROVIDER;
}

// ---------------------------------------------------------------------------
// Provider capabilities — runtime feature discovery
// ---------------------------------------------------------------------------

/**
 * Declares which optional capabilities a tunnel backend supports. Callers
 * check these before requesting a tunnel of a given kind or assuming auth /
 * refresh / stable-hostname behavior.
 */
export interface TunnelProviderCapabilities {
  /** Can expose a port that lives inside a managed sandbox. */
  sandboxPorts: boolean;
  /** Can expose a port on the host running the provider (CLI daemon). */
  localPorts: boolean;
  /**
   * Mints a per-tunnel auth token (returned as `TunnelHandle.token`). When
   * `false`, access is gated only by an unguessable URL — callers that need
   * enforced auth must reject such providers or layer their own gate.
   */
  authTokens: boolean;
  /**
   * Supports explicit refresh before expiry via `refresh()`. When `false`,
   * `refresh()` must be omitted and callers re-`open()` to extend a tunnel.
   */
  refresh: boolean;
  /**
   * Issues a stable custom hostname rather than a random ephemeral one. When
   * `false`, the URL changes on every `open()` and must not be persisted as a
   * durable link.
   */
  stableHostname: boolean;
}

// ---------------------------------------------------------------------------
// Tunnel target + handle
// ---------------------------------------------------------------------------

/** What to expose. */
export interface TunnelTarget {
  /**
   * `sandbox-port`: a service inside the sandbox identified by `sandboxId`.
   * `local-port`: a service on the host running the provider.
   */
  kind: 'sandbox-port' | 'local-port';
  /** Port the service listens on. */
  port: number;
  /** Required when `kind === 'sandbox-port'`; ignored otherwise. */
  sandboxId?: string;
  /** Command that started the service. Observability only — never executed. */
  startCommand?: string;
}

/** Options for opening a tunnel. */
export interface TunnelOpenOptions {
  /**
   * Requested time-to-live in ms. The provider MAY clamp to its own min/max
   * (e.g. the LivePreviewArtifact policy of 30-min default, 4-hour ceiling).
   */
  ttlMs?: number;
  /**
   * Require an enforced auth token even if the provider could expose the URL
   * anonymously. Providers without `capabilities.authTokens` must reject when
   * this is `true` rather than silently downgrading.
   */
  requireAuth?: boolean;
  /**
   * Owner principal for audit + scoping — a durable identifier such as
   * `chatId`, CLI `sessionId`, or a device-token id. Lets the provider scope
   * the tunnel to its owner and reap it when that owner goes away.
   */
  owner?: string;
}

/**
 * A live tunnel. Persist `id` + `provider` to refresh or close later; treat
 * `url` as durable only when the minting provider has `stableHostname`.
 */
export interface TunnelHandle {
  /** Stable id used to refresh / close / reap this tunnel. */
  id: string;
  /** Publicly reachable, token-scoped URL. */
  url: string;
  /** Bearer / path token gating access; undefined when access is URL-only. */
  token?: string;
  /** ms-since-epoch expiry; undefined means no TTL. */
  expiresAt?: number;
  /** Which backend minted this — routes `refresh()` / `close()`. */
  provider: TunnelProviderName;
}

// ---------------------------------------------------------------------------
// Unified error codes (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * Tunnel error codes independent of the backend. Each provider maps its native
 * errors to these so callers don't branch on provider-specific failures.
 */
export type TunnelErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_TARGET'
  | 'AUTH_REQUIRED'
  | 'PORT_UNREACHABLE'
  | 'SANDBOX_NOT_FOUND'
  | 'TUNNEL_NOT_FOUND'
  | 'EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class TunnelError extends Error {
  readonly code: TunnelErrorCode;
  readonly details?: string;

  constructor(message: string, code: TunnelErrorCode, details?: string) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// TunnelProvider — the interface providers implement
// ---------------------------------------------------------------------------

export interface TunnelProvider {
  /** Backend identity (e.g. "cf-sandbox-proxy", "cloudflared"). */
  readonly name: TunnelProviderName;

  /** Declares which optional features this provider supports. */
  readonly capabilities: TunnelProviderCapabilities;

  /**
   * Open a tunnel to `target`, returning a handle with the public URL.
   * Rejects with `UNSUPPORTED_TARGET` when the target kind isn't supported by
   * `capabilities`, or `AUTH_REQUIRED` when `requireAuth` is set but the
   * provider can't mint tokens.
   */
  open(target: TunnelTarget, options?: TunnelOpenOptions): Promise<TunnelHandle>;

  /**
   * Extend a tunnel's TTL and/or rotate its token before expiry. Implemented
   * only by providers with `capabilities.refresh = true`; others omit it and
   * callers re-`open()` instead.
   */
  refresh?(handle: TunnelHandle): Promise<TunnelHandle>;

  /**
   * Tear down a tunnel. Idempotent — does not throw if already closed/expired.
   * Only `id` + `provider` are needed so callers can close from a persisted
   * handle without rehydrating the full record.
   */
  close(handle: Pick<TunnelHandle, 'id' | 'provider'>): Promise<void>;

  /**
   * Enumerate live tunnels this provider is tracking, for orphan reaping and
   * ops visibility. Optional — providers that can't list (stateless proxies)
   * omit it, and callers fall back to owner-scoped bookkeeping.
   */
  list?(): Promise<TunnelHandle[]>;
}
