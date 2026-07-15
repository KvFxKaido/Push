/**
 * Machine-readable headless event output.
 *
 * `push run --jsonl` deliberately reuses the daemon's `push.runtime.v1`
 * envelope instead of inventing a CLI-only stream. Live-only events use the
 * session's current journal cursor, matching pushd: they may repeat `seq` and
 * must not be treated as replay checkpoints by consumers.
 */

import { assertValidEvent, PROTOCOL_VERSION } from '../lib/protocol-schema.ts';
import type { EngineEvent } from './engine.js';
import type { SessionEvent, SessionState } from './session-store.js';

export type JsonlLineWriter = (line: string) => void;

export interface HeadlessJsonlWriter {
  emit(type: string, payload: unknown, runId: string): SessionEvent;
  emitEngineEvent(event: EngineEvent): SessionEvent;
}

export function createHeadlessJsonlWriter(
  state: SessionState,
  writeLine: JsonlLineWriter = (line) => {
    process.stdout.write(line);
  },
  now: () => number = Date.now,
): HeadlessJsonlWriter {
  const emit = (type: string, payload: unknown, runId: string): SessionEvent => {
    const envelope: SessionEvent = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId: state.sessionId,
      runId,
      seq: state.eventSeq,
      ts: now(),
      type,
      payload,
    };
    // This is a public machine boundary, so validate unconditionally rather
    // than relying on PUSH_PROTOCOL_STRICT being enabled by the caller.
    assertValidEvent(envelope);
    writeLine(`${JSON.stringify(envelope)}\n`);
    return envelope;
  };

  return {
    emit,
    emitEngineEvent: (event) => emit(event.type, event.payload, event.runId),
  };
}
