/**
 * handler-types.ts — structural contracts shared by typed pushd handlers.
 *
 * The dispatcher in `cli/pushd.ts` remains the wire boundary while the daemon
 * decomposition is in progress. Extracted handlers consume this validated-enough
 * structural subset instead of importing back through the facade.
 */
import type { DeviceTokenRecord } from '../pushd-device-tokens.js';
import type { PushdWsAuthRecord, PushdWsConnectionState } from '../pushd-ws.js';
import type { DaemonResponse } from './envelopes.js';

export interface DaemonRequest {
  requestId: string;
  type: string;
  sessionId?: string | null;
  payload?: Record<string, unknown> | null;
}

export type DaemonEmitEvent = (event: unknown) => void;

export interface DaemonHandlerContext {
  record?: DeviceTokenRecord;
  auth?: PushdWsAuthRecord;
  wsState?: PushdWsConnectionState;
  relaySenderId?: string;
}

export type DaemonHandler = (
  req: DaemonRequest,
  emitEvent: DaemonEmitEvent,
  context?: DaemonHandlerContext | null,
) => Promise<DaemonResponse>;
