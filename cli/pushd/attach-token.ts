/**
 * attach-token.ts — pushd attach-token validation (Universal Session Bearer).
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). The
 * open-attach warn-dedup WeakSet moves with the validation that maintains it —
 * it is this module's only state, and it is a logging dedup cache, not
 * session-registry ownership.
 */
import process from 'node:process';

/**
 * Structural subset of a daemon session-registry entry that attach-token
 * validation reads. The registry itself stays in `cli/pushd.ts` until the
 * session-runtime extraction phase.
 */
export interface AttachTokenEntry {
  attachToken?: string | null;
  openAttach?: boolean;
  state?: { sessionId?: string; openAttach?: boolean } | null;
}

// Dedup `open_attach_used` to one warn per session entry — the opt-out is a
// deliberate dev mode, so we want visibility, but not a line per RPC. Keyed by
// the registry entry object (WeakSet so evicted entries don't leak).
const openAttachWarnedEntries = new WeakSet<AttachTokenEntry>();

/**
 * Is this session explicitly opted into open (bearer-less) attach? The escape
 * hatch the Universal Session Bearer leaves for deliberate dev use: a
 * per-session `openAttach: true` flag (on the entry or its persisted state) or
 * the process-wide `PUSHD_OPEN_ATTACH=1`. Anything else requires a matching
 * bearer — there is no longer an implicit "tokenless = open" bypass.
 */
function isOpenAttach(entry: AttachTokenEntry | null | undefined): boolean {
  return (
    entry?.openAttach === true ||
    entry?.state?.openAttach === true ||
    process.env.PUSHD_OPEN_ATTACH === '1'
  );
}

export function validateAttachToken(
  entry: AttachTokenEntry | null | undefined,
  providedToken: unknown,
): boolean {
  // No session object = nothing to gate here. Handlers check existence
  // (SESSION_NOT_FOUND) before they ever reach validation, so a null entry is
  // never a real auth decision — it can't be reached with a live session.
  if (!entry) return true;
  // Explicit opt-out only. The former `!entry.attachToken → true` bypass is
  // GONE (Universal Session Bearer): a tokenless session is no longer open by
  // accident. "Open" survives solely as this deliberate, logged choice.
  if (isOpenAttach(entry)) {
    if (!openAttachWarnedEntries.has(entry)) {
      openAttachWarnedEntries.add(entry);
      // Attribute precisely — both can be on at once, so don't collapse to one.
      const envOn = process.env.PUSHD_OPEN_ATTACH === '1';
      const flagOn = entry?.openAttach === true || entry?.state?.openAttach === true;
      const source = flagOn && envOn ? 'session+env' : flagOn ? 'session' : 'env';
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', event: 'open_attach_used', sessionId: entry?.state?.sessionId, source })}\n`,
      );
    }
    return true;
  }
  if (typeof providedToken !== 'string' || !providedToken) return false;
  return entry.attachToken === providedToken;
}
