/**
 * session-transcript-events.ts — the single source of truth for which
 * daemon-broadcast events mutate a session's *persisted* transcript
 * (`state.messages`) out from under already-attached clients.
 *
 * Why this exists: the Addressable Session Verbs (`session_summarize`,
 * `session_revert`, `session_unrevert`) rewrite `state.messages` on the
 * daemon and then broadcast a lifecycle event carrying only metadata
 * (counts, a summary marker) — not the new transcript. An attached TUI
 * or phone that keeps rendering its local copy goes stale: it still
 * shows turns the daemon has dropped (revert) or pre-compaction history
 * the daemon has summarized away (summarize), and a subsequent
 * `session_unrevert` won't visibly restore anything either.
 *
 * The fix both surfaces share: on any event in this set for the attached
 * session, refetch `get_session_messages` and rebuild the visible
 * conversation from the daemon's truth. `get_session_messages` returns
 * the user/assistant history only (same fidelity the web already hydrates
 * with on attach), so the rebuilt view is canonical for those roles;
 * surface-local decoration (TUI tool-call / status lines from the prior
 * in-memory run) is not reconstructed, matching attach-time hydration.
 *
 * Keeping the set here — rather than inlining the three strings in
 * `cli/tui.ts` and `app/src/hooks/useRelayDaemon.ts` — satisfies the
 * cross-surface "one source of truth per vocabulary" rule: a fourth
 * transcript-mutating verb adds its event name once and both clients
 * resync by construction.
 */

/**
 * Event types whose arrival means the daemon's persisted `state.messages`
 * has changed and attached clients must refetch to stay consistent.
 *
 * - `context_compacted` — broadcast by `session_summarize`; older turns
 *   collapsed into a summary.
 * - `session_reverted` — broadcast by `session_revert`; the last N user
 *   turns and their responses were removed.
 * - `session_unreverted` — broadcast by `session_unrevert`; a previously
 *   reverted tail was restored.
 */
export const TRANSCRIPT_MUTATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context_compacted',
  'session_reverted',
  'session_unreverted',
]);

/** True when `eventType` mutates the persisted transcript (see the set above). */
export function isTranscriptMutationEvent(eventType: string): boolean {
  return TRANSCRIPT_MUTATION_EVENT_TYPES.has(eventType);
}
