/**
 * client-attach-state.ts — Per-session CLI-client attach metadata.
 *
 * Tracks the highest `seq` the local `push attach` client has successfully
 * processed for a given session, so that a subsequent attach (after Ctrl+C,
 * a daemon crash, or a transient socket drop) can resume the event stream
 * without replaying the entire event log from seq=0 or — worse — silently
 * dropping the events that landed while the client was offline.
 *
 * This is a *client-side* artifact: the daemon owns `state.json`,
 * `events.jsonl`, and `run.json` in the session dir. We colocate the
 * client file (`client-attach.json`) alongside them so the whole per-session
 * footprint lives under one directory and gets cleaned up together when the
 * session is deleted.
 *
 * Shape intentionally minimal — a single number plus a timestamp is enough
 * to drive the `attach_session` RPC's `lastSeenSeq` parameter. Additional
 * fields can be appended later without a migration because readers tolerate
 * unknown keys.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSessionDir } from './session-store.js';

export interface ClientAttachState {
  /** Highest `seq` from the daemon event stream this client has processed. */
  lastSeenSeq: number;
  /** Wall-clock time of the last write. Informational only. */
  updatedAt: number;
}

const CLIENT_ATTACH_FILENAME = 'client-attach.json';

function getClientAttachPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), CLIENT_ATTACH_FILENAME);
}

/**
 * Read the persisted attach state for a session. Returns a zero-initialised
 * state when no file exists yet (first attach) or when the file is
 * unreadable/corrupt — resuming from `lastSeenSeq: 0` is the safe default
 * because `handleAttachSession` will replay from `(lastSeenSeq || 0) + 1`.
 */
export async function readClientAttachState(sessionId: string): Promise<ClientAttachState> {
  try {
    const raw = await fs.readFile(getClientAttachPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClientAttachState>;
    const lastSeenSeq =
      typeof parsed.lastSeenSeq === 'number' && Number.isFinite(parsed.lastSeenSeq)
        ? Math.max(0, Math.floor(parsed.lastSeenSeq))
        : 0;
    const updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0;
    return { lastSeenSeq, updatedAt };
  } catch {
    return { lastSeenSeq: 0, updatedAt: 0 };
  }
}

/**
 * Persist the given `lastSeenSeq` for a session. Creates the session
 * directory on demand so a client can write this even before the first
 * time the daemon's state.json has landed (unlikely but defensively
 * handled). Never throws — a failed write degrades gracefully into
 * "next attach replays slightly more events than strictly necessary".
 */
export async function writeClientAttachState(
  sessionId: string,
  lastSeenSeq: number,
): Promise<void> {
  if (!Number.isFinite(lastSeenSeq) || lastSeenSeq < 0) return;
  const state: ClientAttachState = {
    lastSeenSeq: Math.floor(lastSeenSeq),
    updatedAt: Date.now(),
  };
  const dir = getSessionDir(sessionId);
  const filePath = getClientAttachPath(sessionId);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s `mode` option is only honored when the directory is
    // actually created — it's silently ignored if `dir` already exists
    // with looser permissions. Apply `chmod` explicitly so a pre-existing
    // session directory gets tightened to 0o700. Matches the pattern in
    // `session-store.ts:ensureSessionDir`.
    await fs.chmod(dir, 0o700);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Same caveat as above: `writeFile`'s `mode` option only applies on
    // file creation. If a previous run left `client-attach.json` at
    // 0o644, we need an explicit `chmod` to restore the restrictive
    // permissions we advertise in the module doc.
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best effort — see function doc.
  }
}

/**
 * Debounced writer factory. Returns `{ schedule, flush }` where `schedule`
 * coalesces rapid-fire updates (e.g., one per incoming event) into a single
 * filesystem write every `debounceMs`, and `flush` forces an immediate
 * write of the latest value. Used by `runAttach` to avoid hammering disk
 * during a token-stream run while still guaranteeing a persist on detach.
 */
export function makeDebouncedClientAttachWriter(sessionId: string, debounceMs: number = 250) {
  let pendingSeq: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPersistedSeq = -1;

  async function persist(): Promise<void> {
    if (pendingSeq === null) return;
    const seqToWrite = pendingSeq;
    pendingSeq = null;
    if (seqToWrite <= lastPersistedSeq) return;
    lastPersistedSeq = seqToWrite;
    await writeClientAttachState(sessionId, seqToWrite);
  }

  return {
    schedule(seq: number): void {
      if (!Number.isFinite(seq) || seq < 0) return;
      const floored = Math.floor(seq);
      if (pendingSeq !== null && floored <= pendingSeq) return;
      pendingSeq = floored;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void persist();
      }, debounceMs);
      // Don't keep the event loop alive just for a debounced persist.
      if (typeof timer.unref === 'function') timer.unref();
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await persist();
    },
  };
}
