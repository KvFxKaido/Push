/**
 * device-admin-handlers.ts — token, relay, pairing, and device handlers.
 *
 * The factory receives the process-owned WS/session registries and the relay
 * coordinator. Authorization, cascade revocation, pairing, audit provenance,
 * and response shapes stay beside the handlers that enforce them.
 */
import process from 'node:process';

import { appendAuditEvent } from '../pushd-audit-log.js';
import {
  getAttachTokenTtlMs,
  listDeviceAttachTokens,
  mintDeviceAttachToken,
  revokeAttachTokensByParent,
  revokeDeviceAttachToken,
} from '../pushd-attach-tokens.js';
import {
  listDeviceTokens,
  mintDeviceToken,
  revokeDeviceToken,
  type DeviceTokenRecord,
} from '../pushd-device-tokens.js';
import { encodeRemotePairBundle } from '../pushd-relay-pair-bundle.js';
import {
  deleteRelayConfig,
  isValidRelayToken,
  readRelayConfig,
  writeRelayConfig,
  type RelayConfig,
} from '../pushd-relay-config.js';
import type { PushdWsHandle } from '../pushd-ws.js';
import { makeAttachToken } from '../session-store.js';
import { auditProvenance } from './audit-provenance.js';
import { makeErrorResponse, makeResponse, type DaemonResponse } from './envelopes.js';
import type {
  DaemonEmitEvent,
  DaemonHandler,
  DaemonHandlerContext,
  DaemonRequest,
} from './handler-types.js';
import type { RelayCoordinator } from './relay-coordinator.js';

interface MintableSessionState {
  attachToken?: string | null;
  sessionId?: string;
  [key: string]: unknown;
}

export interface MintableSessionEntry {
  attachToken?: string | null;
  state?: MintableSessionState | null;
  [key: string]: unknown;
}

export interface DeviceAdminHandlerDependencies {
  relay: RelayCoordinator;
  getWsHandle(): PushdWsHandle | null;
  sessions: Map<string, MintableSessionEntry>;
  loadSessionState(sessionId: string): Promise<MintableSessionState>;
  saveSessionState(state: MintableSessionState): Promise<void>;
}

export interface DeviceAdminHandlers {
  handleRevokeDeviceToken: DaemonHandler;
  handleMintDeviceAttachToken: DaemonHandler;
  handleRevokeDeviceAttachToken: DaemonHandler;
  handleRelayEnable: DaemonHandler;
  handleRelayDisable: DaemonHandler;
  handleRelayStatus: DaemonHandler;
  handleMintRemotePairBundle: DaemonHandler;
  handleGrantSessionAttach: DaemonHandler;
  handleListAttachTokens: DaemonHandler;
  handleListDevices: DaemonHandler;
}

function refuseFromWs(req: DaemonRequest, type: string): DaemonResponse {
  return makeErrorResponse(
    req.requestId,
    type,
    'UNSUPPORTED_VIA_TRANSPORT',
    `${type} is only available over the Unix-socket admin transport.`,
  );
}

export function resolveOrMintTargetAttachToken(entry: MintableSessionEntry): {
  token: string;
  minted: boolean;
} {
  if (!entry || typeof entry !== 'object') {
    throw new Error('resolveOrMintTargetAttachToken requires a session entry object');
  }
  if (entry.attachToken) return { token: entry.attachToken, minted: false };

  const token = makeAttachToken();
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event: 'attach_token_minted_unexpectedly', sessionId: entry.state?.sessionId })}\n`,
  );
  entry.attachToken = token;
  if (entry.state && typeof entry.state === 'object') entry.state.attachToken = token;
  return { token, minted: true };
}

export function createDeviceAdminHandlers(
  dependencies: DeviceAdminHandlerDependencies,
): DeviceAdminHandlers {
  const { relay, getWsHandle, sessions, loadSessionState, saveSessionState } = dependencies;

  const handleRevokeDeviceToken: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'revoke_device_token');
    const tokenId = typeof req.payload?.tokenId === 'string' ? req.payload.tokenId : '';
    if (!tokenId) {
      return makeErrorResponse(
        req.requestId,
        'revoke_device_token',
        'INVALID_REQUEST',
        'tokenId is required',
      );
    }
    if (!(await revokeDeviceToken(tokenId))) {
      return makeErrorResponse(
        req.requestId,
        'revoke_device_token',
        'TOKEN_NOT_FOUND',
        `no such token: ${tokenId}`,
      );
    }

    const revokedAttachIds = await revokeAttachTokensByParent(tokenId);
    const wsHandle = getWsHandle();
    const closedConnections = wsHandle
      ? wsHandle.disconnectByTokenId(tokenId, 'device token revoked')
      : 0;
    relay.revokeAttachTokens(revokedAttachIds);
    void appendAuditEvent({
      type: 'auth.revoke_device',
      ...auditProvenance(context),
      payload: { tokenId, closedConnections, revokedAttachTokens: revokedAttachIds },
    });
    return makeResponse(req.requestId, 'revoke_device_token', null, true, {
      tokenId,
      closedConnections,
      revokedAttachTokens: revokedAttachIds,
    });
  };

  const handleMintDeviceAttachToken: DaemonHandler = async (req, _emitEvent, context) => {
    const auth = context?.auth;
    if (!auth) {
      return makeErrorResponse(
        req.requestId,
        'mint_device_attach_token',
        'UNSUPPORTED_VIA_TRANSPORT',
        'mint_device_attach_token is only available over the WebSocket transport.',
      );
    }
    if (auth.kind !== 'device') {
      return makeErrorResponse(
        req.requestId,
        'mint_device_attach_token',
        'DEVICE_TOKEN_REQUIRED',
        'mint_device_attach_token requires a device-token-authenticated connection.',
      );
    }

    const result = await mintDeviceAttachToken({
      parentTokenId: auth.tokenId,
      boundOrigin: auth.boundOrigin,
    });
    relay.allowAttachToken(result.tokenId, result.record.tokenHash);
    void appendAuditEvent({
      type: 'auth.mint_attach',
      ...auditProvenance(context),
      payload: {
        mintedTokenId: result.tokenId,
        parentTokenId: auth.tokenId,
        ttlMs: result.ttlMs,
      },
    });
    return makeResponse(req.requestId, 'mint_device_attach_token', null, true, {
      token: result.token,
      tokenId: result.tokenId,
      ttlMs: result.ttlMs,
      parentTokenId: auth.tokenId,
    });
  };

  const handleRevokeDeviceAttachToken: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'revoke_device_attach_token');
    const tokenId = typeof req.payload?.tokenId === 'string' ? req.payload.tokenId : '';
    if (!tokenId) {
      return makeErrorResponse(
        req.requestId,
        'revoke_device_attach_token',
        'INVALID_REQUEST',
        'tokenId is required',
      );
    }
    if (!(await revokeDeviceAttachToken(tokenId))) {
      return makeErrorResponse(
        req.requestId,
        'revoke_device_attach_token',
        'TOKEN_NOT_FOUND',
        `no such attach token: ${tokenId}`,
      );
    }

    const wsHandle = getWsHandle();
    const closedConnections = wsHandle
      ? wsHandle.disconnectByAttachTokenId(tokenId, 'attach token revoked')
      : 0;
    relay.revokeAttachToken(tokenId);
    void appendAuditEvent({
      type: 'auth.revoke_attach',
      ...auditProvenance(context),
      payload: { tokenId, closedConnections },
    });
    return makeResponse(req.requestId, 'revoke_device_attach_token', null, true, {
      tokenId,
      closedConnections,
    });
  };

  const handleRelayEnable: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'relay_enable');
    const deploymentUrl =
      typeof req.payload?.deploymentUrl === 'string' ? req.payload.deploymentUrl.trim() : '';
    const token = typeof req.payload?.token === 'string' ? req.payload.token : '';
    if (!deploymentUrl) {
      return makeErrorResponse(
        req.requestId,
        'relay_enable',
        'INVALID_REQUEST',
        'deploymentUrl is required',
      );
    }
    if (!isValidRelayToken(token)) {
      return makeErrorResponse(
        req.requestId,
        'relay_enable',
        'INVALID_REQUEST',
        'token must start with pushd_relay_ and include a token body (yours looks truncated)',
      );
    }

    let persisted: RelayConfig;
    try {
      persisted = await writeRelayConfig({ deploymentUrl, token });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeErrorResponse(req.requestId, 'relay_enable', 'INTERNAL_ERROR', message);
    }
    relay.stop();
    try {
      relay.start(persisted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeErrorResponse(req.requestId, 'relay_enable', 'INTERNAL_ERROR', message);
    }
    return makeResponse(req.requestId, 'relay_enable', null, true, {
      deploymentUrl: persisted.deploymentUrl,
      enabledAt: persisted.enabledAt,
    });
  };

  const handleRelayDisable: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'relay_disable');
    let removed = false;
    try {
      removed = await deleteRelayConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeErrorResponse(req.requestId, 'relay_disable', 'INTERNAL_ERROR', message);
    }
    const wasActive = relay.isRunning();
    relay.stop({ clearAllowlist: true });
    return makeResponse(req.requestId, 'relay_disable', null, true, {
      configRemoved: removed,
      clientStopped: wasActive,
    });
  };

  const handleRelayStatus: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'relay_status');
    return makeResponse(
      req.requestId,
      'relay_status',
      null,
      true,
      await relay.buildStatusPayload(),
    );
  };

  const handleMintRemotePairBundle: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'mint_remote_pair_bundle');
    const config = await readRelayConfig();
    if (!config) {
      return makeErrorResponse(
        req.requestId,
        'mint_remote_pair_bundle',
        'RELAY_NOT_ENABLED',
        'Relay is not enabled. Run `push daemon relay enable --url <…> --token <…>` first.',
      );
    }

    const targetSessionId =
      typeof req.payload?.targetSessionId === 'string' && req.payload.targetSessionId.length > 0
        ? req.payload.targetSessionId
        : null;
    const targetAttachToken =
      typeof req.payload?.targetAttachToken === 'string' && req.payload.targetAttachToken.length > 0
        ? req.payload.targetAttachToken
        : null;
    if (!targetSessionId && targetAttachToken) {
      return makeErrorResponse(
        req.requestId,
        'mint_remote_pair_bundle',
        'INVALID_REQUEST',
        'targetAttachToken requires targetSessionId.',
      );
    }

    let resolvedTargetAttachToken = targetAttachToken;
    let mintedSessionAttachToken: string | null = null;
    if (targetSessionId && targetAttachToken) {
      const entry = sessions.get(targetSessionId);
      if (!entry || entry.attachToken !== targetAttachToken) {
        return makeErrorResponse(
          req.requestId,
          'mint_remote_pair_bundle',
          'INVALID_TOKEN',
          'Target daemon session is not active or its attach token did not match.',
        );
      }
    }
    if (targetSessionId && !targetAttachToken) {
      const entry = sessions.get(targetSessionId);
      if (!entry) {
        return makeErrorResponse(
          req.requestId,
          'mint_remote_pair_bundle',
          'SESSION_NOT_FOUND',
          'Target daemon session is not active.',
        );
      }
      const resolved = resolveOrMintTargetAttachToken(entry);
      resolvedTargetAttachToken = resolved.token;
      if (resolved.minted) {
        mintedSessionAttachToken = resolved.token;
        if (entry.state && typeof entry.state === 'object') {
          try {
            await saveSessionState(entry.state);
            process.stderr.write(
              `${JSON.stringify({ level: 'info', event: 'pair_bundle_minted_session_token', targetSessionId })}\n`,
            );
          } catch (error) {
            process.stderr.write(
              `${JSON.stringify({ level: 'warn', event: 'pair_bundle_mint_persist_failed', targetSessionId, error: error instanceof Error ? error.message : String(error) })}\n`,
            );
          }
        }
      }
    }

    const device = await mintDeviceToken({ boundOrigin: 'loopback' });
    const attach = await mintDeviceAttachToken({
      parentTokenId: device.tokenId,
      boundOrigin: 'loopback',
    });
    relay.allowAttachToken(attach.tokenId, attach.record.tokenHash);
    const bundle = encodeRemotePairBundle({
      deploymentUrl: config.deploymentUrl,
      sessionId: relay.sessionId,
      token: attach.token,
      attachTokenId: attach.tokenId,
      deviceTokenId: device.tokenId,
      ...(targetSessionId && resolvedTargetAttachToken
        ? { targetSessionId, targetAttachToken: resolvedTargetAttachToken }
        : {}),
    });
    void appendAuditEvent({
      type: 'auth.mint_attach',
      surface: 'unix-socket',
      payload: {
        mintedTokenId: attach.tokenId,
        parentTokenId: device.tokenId,
        ttlMs: attach.ttlMs,
        remote: true,
        targetSessionId: targetSessionId ?? undefined,
      },
    });
    return makeResponse(req.requestId, 'mint_remote_pair_bundle', null, true, {
      bundle,
      deviceTokenId: device.tokenId,
      attachTokenId: attach.tokenId,
      sessionId: relay.sessionId,
      targetSessionId,
      deploymentUrl: config.deploymentUrl,
      ttlMs: attach.ttlMs,
      ...(mintedSessionAttachToken ? { mintedTargetAttachToken: mintedSessionAttachToken } : {}),
    });
  };

  const handleGrantSessionAttach: DaemonHandler = async (req, _emitEvent, context) => {
    const sessionId =
      typeof req.payload?.sessionId === 'string' && req.payload.sessionId.length > 0
        ? req.payload.sessionId
        : null;
    if (!sessionId) {
      return makeErrorResponse(
        req.requestId,
        'grant_session_attach',
        'INVALID_REQUEST',
        'sessionId is required',
      );
    }

    let entry = sessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        sessions.set(sessionId, entry);
      } catch {
        return makeErrorResponse(
          req.requestId,
          'grant_session_attach',
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        );
      }
    }

    const resolved = resolveOrMintTargetAttachToken(entry);
    if (resolved.minted && entry.state && typeof entry.state === 'object') {
      try {
        await saveSessionState(entry.state);
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', event: 'grant_attach_mint_persist_failed', sessionId, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
      }
    }
    void appendAuditEvent({
      type: 'auth.grant_session_attach',
      ...auditProvenance(context),
      sessionId,
      payload: {
        minted: resolved.minted,
        relaySenderId:
          typeof context?.relaySenderId === 'string' ? context.relaySenderId : undefined,
      },
    });
    return makeResponse(req.requestId, 'grant_session_attach', null, true, {
      sessionId,
      attachToken: resolved.token,
    });
  };

  const handleListAttachTokens: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'list_attach_tokens');
    const records = await listDeviceAttachTokens();
    return makeResponse(req.requestId, 'list_attach_tokens', null, true, {
      tokens: records.map((record) => ({
        tokenId: record.tokenId,
        parentTokenId: record.parentTokenId,
        boundOrigin: record.boundOrigin,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      })),
      ttlMs: getAttachTokenTtlMs(),
    });
  };

  const handleListDevices: DaemonHandler = async (req, _emitEvent, context) => {
    if (context?.record || context?.auth) return refuseFromWs(req, 'list_devices');
    const wsHandle = getWsHandle();
    if (!wsHandle) {
      return makeResponse(req.requestId, 'list_devices', null, true, {
        devices: [],
        wsListenerActive: false,
      });
    }

    const liveRows = wsHandle.listConnectedDevices();
    let fileRecords: DeviceTokenRecord[] = [];
    try {
      fileRecords = await listDeviceTokens();
    } catch {
      // Live WS state remains useful if the token store cannot be read.
    }
    const fileByTokenId = new Map(fileRecords.map((record) => [record.tokenId, record]));
    const devices = liveRows.map((row) => ({
      tokenId: row.tokenId,
      boundOrigin: row.boundOrigin,
      connections: row.connections,
      attachConnections: row.attachConnections,
      deviceConnections: row.deviceConnections,
      lastUsedAt: fileByTokenId.get(row.tokenId)?.lastUsedAt ?? row.lastUsedAt,
    }));
    return makeResponse(req.requestId, 'list_devices', null, true, {
      devices,
      wsListenerActive: true,
    });
  };

  return {
    handleRevokeDeviceToken,
    handleMintDeviceAttachToken,
    handleRevokeDeviceAttachToken,
    handleRelayEnable,
    handleRelayDisable,
    handleRelayStatus,
    handleMintRemotePairBundle,
    handleGrantSessionAttach,
    handleListAttachTokens,
    handleListDevices,
  };
}
