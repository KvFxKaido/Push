/**
 * envelopes.ts — pushd response/error envelope construction.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Pure
 * constructors over the NDJSON response envelope. The protocol version is
 * imported from its canonical home in `lib/protocol-schema.ts`; the response
 * envelope shape is intentionally NOT re-declared as a runtime validator —
 * `lib/protocol-schema.ts` scopes runtime validation to event envelopes and
 * documents request/response validation as a non-goal.
 */
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.js';

export interface DaemonResponseError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DaemonResponse {
  v: typeof PROTOCOL_VERSION;
  kind: 'response';
  requestId: string;
  type: string;
  sessionId: string | null;
  ok: boolean;
  payload: unknown;
  error: DaemonResponseError | null;
}

export function makeResponse(
  requestId: string,
  type: string,
  sessionId: string | null | undefined,
  ok: boolean,
  payload: unknown,
  error: DaemonResponseError | null = null,
): DaemonResponse {
  return {
    v: PROTOCOL_VERSION,
    kind: 'response',
    requestId,
    type,
    sessionId: sessionId || null,
    ok,
    payload,
    error,
  };
}

export function makeErrorResponse(
  requestId: string,
  type: string,
  code: string,
  message: string,
  retryable = false,
): DaemonResponse {
  return makeResponse(
    requestId,
    type,
    null,
    false,
    {},
    {
      code,
      message,
      retryable,
    },
  );
}
