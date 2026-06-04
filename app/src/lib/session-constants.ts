/**
 * session-constants.ts — the wire vocabulary for the Push identity session,
 * shared between the Worker (producer/verifier, `app/src/worker/worker-session.ts`)
 * and the client (consumer, `app/src/lib/session-auth.ts`).
 *
 * One definition per the repo's "one source of truth per vocabulary" rule
 * (CLAUDE.md → New feature checklist §3): the header name is a cross-surface
 * contract, so it lives here rather than being duplicated and kept in sync by
 * comment. No logic/deps so either build target can import it freely.
 */

/** Request header carrying the session token (APK/cross-surface fallback to the cookie). */
export const SESSION_HEADER = 'X-Push-Session';
