/**
 * Shared lazy-load + bearer validation for session-scoped daemon handlers.
 * Restores the persisted token on disk-load; a legacy tokenless session is
 * claimed only by `attach_session` (bootstrap grace), so a tokenless read
 * here is rejected — the implicit tokenless bypass is gone (Universal
 * Session Bearer). Returns `{ entry, sessionId }` on success or `{ error }`
 * ready to return.
 */
import { loadSessionState } from '../session-store.js';
import { validateAttachToken } from './attach-token.js';
import { makeErrorResponse, type DaemonResponse } from './envelopes.js';
import type { DaemonRequest } from './handler-types.js';
import type { SessionRuntime, SessionRuntimeEntry } from './session-runtime.js';

type SessionAuthRequest = Omit<DaemonRequest, 'payload'> & { payload?: any };

export type SessionAuthResult =
  | {
      entry: SessionRuntimeEntry;
      sessionId: string;
      error?: never;
    }
  | {
      error: DaemonResponse;
      entry?: never;
      sessionId?: never;
    };

export type LoadAndAuthSession = (
  request: SessionAuthRequest,
  type: string,
) => Promise<SessionAuthResult>;

export function createSessionAuthenticator(runtime: SessionRuntime): LoadAndAuthSession {
  return async (request, type) => {
    const sessionId = request.sessionId || request.payload?.sessionId;
    const providedToken = request.payload?.attachToken;
    if (!sessionId) {
      return {
        error: makeErrorResponse(
          request.requestId,
          type,
          'INVALID_REQUEST',
          'sessionId is required',
        ),
      };
    }

    let entry = runtime.sessions.get(sessionId);
    if (!entry) {
      try {
        const state = await loadSessionState(sessionId);
        entry = { state, attachToken: state.attachToken };
        runtime.sessions.set(sessionId, entry);
      } catch {
        return {
          error: makeErrorResponse(
            request.requestId,
            type,
            'SESSION_NOT_FOUND',
            `Session not found: ${sessionId}`,
          ),
        };
      }
    }

    if (!validateAttachToken(entry, providedToken)) {
      return {
        error: makeErrorResponse(
          request.requestId,
          type,
          'INVALID_TOKEN',
          'Invalid or missing attach token',
        ),
      };
    }

    return { entry, sessionId };
  };
}
