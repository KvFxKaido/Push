/**
 * relay-coordinator.ts — ownership boundary for pushd's outbound relay.
 *
 * Owns the live relay client, connection status, hashed phone allowlist,
 * transport-scoped cancellation state, and relay session registrations. The
 * pushd spine supplies dispatch and session fan-out callbacks but retains no
 * relay mutable of its own.
 */
import os from 'node:os';

import { PROTOCOL_VERSION, RELAY_SENDER_FIELD } from '../../lib/protocol-schema.js';
import { appendAuditEvent } from '../pushd-audit-log.js';
import {
  createRelayAllowlistRegistry,
  seedAllowlistFromAttachTokens,
} from '../pushd-relay-allowlist.js';
import {
  startPushdRelayClient,
  type PushdRelayClientOptions,
  type RelayClientHandle,
  type RelayConnectionStatus,
} from '../pushd-relay-client.js';
import { readRelayConfig, type RelayConfig } from '../pushd-relay-config.js';
import { listDeviceAttachTokens } from '../pushd-attach-tokens.js';
import type { PushdWsAuthRecord, PushdWsConnectionState } from '../pushd-ws.js';
import { makeErrorResponse, type DaemonResponse } from './envelopes.js';
import type { DaemonEmitEvent, DaemonHandlerContext } from './handler-types.js';
import { makeRequestId } from './ids.js';

interface RelayInboundRequest {
  v?: string;
  kind?: string;
  requestId?: string;
  type?: string;
  sessionId?: string;
  payload?: {
    sessionId?: string;
    capabilities?: unknown;
    [key: string]: unknown;
  };
  [RELAY_SENDER_FIELD]?: string;
}

interface RelayClientLike {
  send(frame: string): void;
  close?(): void;
}

export interface RelayCoordinatorDependencies {
  dispatch(
    request: RelayInboundRequest,
    emitEvent: DaemonEmitEvent,
    context: DaemonHandlerContext,
  ): Promise<DaemonResponse>;
  addSessionClient(sessionId: string, emitEvent: DaemonEmitEvent, capabilities: unknown): void;
  startClient?(options: PushdRelayClientOptions): RelayClientHandle;
}

export interface RelayStatusPayload {
  persisted: { deploymentUrl: string; enabledAt: number | null } | null;
  live:
    | { running: false }
    | {
        running: true;
        deploymentUrl: string | null;
        state: string;
        attempt: number;
        exhausted: boolean;
        closeCode: number | null;
        closeReason: string | null;
        fatal: boolean;
        allowlistSize: number;
      };
}

const RELAY_SYNTHETIC_AUTH: PushdWsAuthRecord = {
  kind: 'attach',
  tokenId: 'pdat_relay',
  parentDeviceTokenId: 'pdt_relay',
  boundOrigin: 'relay',
  lastUsedAt: null,
  deviceRecord: null,
};

function makeRelayPhoneAllowEnvelope(tokenHashes: readonly string[]): string {
  return `${JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay_phone_allow',
    tokenHashes,
    ts: Date.now(),
  })}\n`;
}

function makeRelayPhoneRevokeEnvelope(tokenHashes: readonly string[]): string {
  return `${JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: 'relay_phone_revoke',
    tokenHashes,
    ts: Date.now(),
  })}\n`;
}

export class RelayCoordinator {
  readonly #dependencies: RelayCoordinatorDependencies;
  readonly #allowlist = createRelayAllowlistRegistry();
  readonly #sessionRegistrations = new Set<string>();
  #activeClient: RelayClientLike | null = null;
  #deploymentUrl: string | null = null;
  #lastStatus: RelayConnectionStatus | null = null;
  #wsState: PushdWsConnectionState | null = null;

  constructor(dependencies: RelayCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  // Phase 2.d.1 walk-back: sessionId is opaque routing, not
  // security-load-bearing. A stable per-daemon id is fine — the
  // allowlist is the actual gate. Derive it from the hostname so
  // operator inspection ("which DO is this daemon talking to?")
  // stays human-readable; salting it with a process startup nonce
  // would force a fresh DO instance on every restart, which is
  // wasteful for what the field actually does.
  get sessionId(): string {
    return `pushd-${os.hostname()}`;
  }

  isRunning(): boolean {
    return this.#activeClient !== null;
  }

  async seedAllowlistFromAttachTokens(): Promise<number> {
    return seedAllowlistFromAttachTokens(this.#allowlist, listDeviceAttachTokens);
  }

  allowAttachToken(tokenId: string, tokenHash: string): void {
    this.#allowlist.add(tokenId, tokenHash);
    this.#emitAllowChange([tokenHash]);
  }

  revokeAttachToken(tokenId: string): string | null {
    const tokenHash = this.#allowlist.remove(tokenId);
    if (tokenHash !== null) this.#emitRevokeChange([tokenHash]);
    return tokenHash;
  }

  revokeAttachTokens(tokenIds: readonly string[]): string[] {
    const tokenHashes = this.#allowlist.removeMany(tokenIds);
    if (tokenHashes.length > 0) this.#emitRevokeChange(tokenHashes);
    return tokenHashes;
  }

  async startPersisted(): Promise<RelayConfig | null> {
    const config = await readRelayConfig();
    if (config) this.start(config);
    return config;
  }

  start(config: RelayConfig): RelayClientHandle {
    let handleRef: RelayClientHandle | null = null;
    const wsState: PushdWsConnectionState = { activeRuns: new Map() };
    this.#wsState = wsState;

    const emitToRelay: DaemonEmitEvent = (event) => {
      if (!handleRef) return;
      try {
        handleRef.send(`${JSON.stringify(event)}\n`);
      } catch {
        // The relay client's queue handles closed/reconnecting transports.
      }
    };

    const startClient = this.#dependencies.startClient ?? startPushdRelayClient;
    const handle = startClient({
      deploymentUrl: config.deploymentUrl,
      sessionId: this.sessionId,
      token: config.token,
      onStatus: (status) => {
        this.#lastStatus = status;
        if (status.state === 'open') {
          void appendAuditEvent({
            type: 'relay.connect',
            surface: 'unix-socket',
            payload: { deploymentUrl: config.deploymentUrl },
          });
        } else if (status.state === 'closed' || status.state === 'unreachable') {
          void appendAuditEvent({
            type: 'relay.disconnect',
            surface: 'unix-socket',
            payload: {
              deploymentUrl: config.deploymentUrl,
              state: status.state,
              code: status.code,
              reason: status.reason,
              attempt: status.attempt,
              exhausted: status.exhausted,
            },
          });
        }
      },
      onOpen: (send) => {
        // Re-emit the full allowlist after a relay (re)connect. The DO's
        // per-session allowlist is in-memory and per-DO-instance, so a DO
        // restart in the middle of a session would lose it; pushd's full
        // re-emit is the recovery path.
        const hashes = this.#allowlist.allTokenHashes();
        if (hashes.length > 0) send(makeRelayPhoneAllowEnvelope(hashes));
      },
      onMessage: async (text) => {
        await this.#handleMessage(text, emitToRelay, wsState);
      },
    });
    handleRef = handle;
    this.#activeClient = handle;
    this.#deploymentUrl = config.deploymentUrl;
    return handle;
  }

  /**
   * Tear down the running relay client. By default the in-process
   * tokenHash allowlist is PRESERVED — entries are reseeded at boot
   * from the persisted attach-token store and adjusted at mint/revoke,
   * so clearing here would force a full re-emit cycle on the next
   * `relay.connect`. Only the explicit `relay disable` flow passes
   * `clearAllowlist: true` (config gone → no relay → no allowlist
   * needed).
   *
   * PR #529 Codex P1 + Copilot: `handleRelayEnable` calls this in its
   * live-restart path; without the preserve default, a disable/enable
   * cycle (or even a first enable with phones already paired locally
   * before the relay token arrived) would re-emit an empty allowlist
   * on the next connect.
   */
  stop(options: { clearAllowlist?: boolean } = {}): void {
    if (this.#activeClient) {
      try {
        this.#activeClient.close?.();
      } catch {
        // Shutdown is best-effort.
      }
      this.#activeClient = null;
    }
    this.#deploymentUrl = null;
    this.#lastStatus = null;

    if (this.#wsState) {
      for (const run of this.#wsState.activeRuns.values()) {
        try {
          run.controller.abort();
        } catch {
          // Cancellation is best-effort during teardown.
        }
      }
      this.#wsState.activeRuns.clear();
      this.#wsState = null;
    }

    // Preserve the legacy registry behavior: the coordinator drops its
    // bookkeeping while closed relay sends remain no-ops in the fan-out map.
    this.#sessionRegistrations.clear();
    if (options.clearAllowlist) this.#allowlist.clear();
  }

  async buildStatusPayload(): Promise<RelayStatusPayload> {
    let persistedDeploymentUrl: string | null = null;
    let persistedEnabledAt: number | null = null;
    try {
      const config = await readRelayConfig();
      if (config) {
        persistedDeploymentUrl = config.deploymentUrl;
        persistedEnabledAt = config.enabledAt;
      }
    } catch {
      // Live state remains useful when persisted config is unreadable.
    }

    const status = this.#lastStatus;
    const live: RelayStatusPayload['live'] = this.#activeClient
      ? {
          running: true,
          deploymentUrl: this.#deploymentUrl,
          state: status?.state ?? 'connecting',
          attempt: status && 'attempt' in status ? status.attempt : 0,
          exhausted:
            status && (status.state === 'closed' || status.state === 'unreachable')
              ? status.exhausted
              : false,
          closeCode:
            status && (status.state === 'closed' || status.state === 'unreachable')
              ? status.code
              : null,
          closeReason:
            status && (status.state === 'closed' || status.state === 'unreachable')
              ? status.reason
              : null,
          fatal:
            status && (status.state === 'closed' || status.state === 'unreachable')
              ? (status.fatal ?? false)
              : false,
          allowlistSize: this.#allowlist.size(),
        }
      : { running: false };

    return {
      persisted: persistedDeploymentUrl
        ? { deploymentUrl: persistedDeploymentUrl, enabledAt: persistedEnabledAt }
        : null,
      live,
    };
  }

  /** Compatibility seam for lifecycle tests; production uses start/stop. */
  setActiveForTesting(handle: RelayClientLike | null): void {
    this.#activeClient = handle;
  }

  #emitAllowChange(tokenHashes: readonly string[]): void {
    if (tokenHashes.length === 0 || !this.#activeClient) return;
    this.#activeClient.send(makeRelayPhoneAllowEnvelope(tokenHashes));
  }

  #emitRevokeChange(tokenHashes: readonly string[]): void {
    if (tokenHashes.length === 0 || !this.#activeClient) return;
    this.#activeClient.send(makeRelayPhoneRevokeEnvelope(tokenHashes));
  }

  async #handleMessage(
    text: string,
    emitToRelay: DaemonEmitEvent,
    wsState: PushdWsConnectionState,
  ): Promise<void> {
    // Each text frame may carry one or more NDJSON envelopes —
    // mirror pushd-ws.ts's parsing exactly. Malformed lines drop
    // silently; an attacker can't differentiate parse failures
    // from anything else and a friendly client would never send
    // malformed bytes through the relay.
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: RelayInboundRequest;
      try {
        parsed = JSON.parse(trimmed) as RelayInboundRequest;
      } catch {
        continue;
      }
      // Only `request` envelopes drive dispatch. Other kinds
      // (responses pushd would itself send, relay-control envelopes
      // consumed by the DO before reaching pushd, malformed
      // payloads) drop silently — see pushd-ws.ts for the same
      // discrimination.
      if (parsed.kind !== 'request') continue;

      let response: DaemonResponse;
      try {
        // The relay DO stamps the per-connection sender id onto every
        // forwarded phone→pushd frame (`RELAY_SENDER_FIELD`). It's the only
        // trustworthy phone identity here — the shared `wsState` can't tell
        // paired phones apart — so it scopes run ownership (Audit #3). A
        // string-typed value only; anything else (absent, forged non-string)
        // resolves to undefined and the run registers unowned.
        const stampedSenderId = parsed[RELAY_SENDER_FIELD];
        const relaySenderId =
          typeof stampedSenderId === 'string' && stampedSenderId ? stampedSenderId : undefined;
        response = await this.#dependencies.dispatch(parsed, emitToRelay, {
          auth: RELAY_SYNTHETIC_AUTH,
          wsState,
          relaySenderId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'internal error';
        response = makeErrorResponse(
          parsed.requestId ?? makeRequestId(),
          parsed.type ?? 'unknown',
          'INTERNAL_ERROR',
          message,
        );
      }
      emitToRelay(response);

      // Mirror pushd-ws.ts: register the relay's emit as a session
      // client when the phone attaches or starts a session, so
      // streamed events flow back through the relay. Cleanup on
      // shutdown / disable in `stop()`.
      if (parsed.type === 'attach_session' && response.ok) {
        const sessionId = parsed.payload?.sessionId;
        if (sessionId) {
          this.#dependencies.addSessionClient(
            sessionId,
            emitToRelay,
            parsed.payload?.capabilities ?? null,
          );
          this.#sessionRegistrations.add(sessionId);
        }
      }
      if ((parsed.type === 'start_session' || parsed.type === 'send_user_message') && response.ok) {
        const responsePayload = response.payload as { sessionId?: string } | undefined;
        const sessionId =
          response.sessionId ||
          responsePayload?.sessionId ||
          parsed.sessionId ||
          parsed.payload?.sessionId;
        if (sessionId) {
          this.#dependencies.addSessionClient(
            sessionId,
            emitToRelay,
            parsed.payload?.capabilities ?? null,
          );
          this.#sessionRegistrations.add(sessionId);
        }
      }
    }
  }
}

export function createRelayCoordinator(
  dependencies: RelayCoordinatorDependencies,
): RelayCoordinator {
  return new RelayCoordinator(dependencies);
}
