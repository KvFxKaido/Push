/**
 * On-device lane keying — the collision-free scheme that maps a durable scope
 * value (a repo `owner/name`, a branch) to a filesystem-safe directory segment.
 *
 * Shared by every native-on-device store keyed by `repoFullName + branch`: the
 * checkpoint repo (`checkpoint/native-jgit-store.ts`) and the session working
 * copy (`native-working-copy.ts`). Keeping ONE implementation guarantees the two
 * stores derive byte-identical segments for the same scope — so a scope's
 * working copy and its checkpoints always sort under the same lane names, and a
 * future "purge this lane" touches both consistently.
 *
 * The two-part segment (`<sanitized>-<hash>`) is deliberate: sanitizing alone is
 * lossy (`feat/x`, `feat:x`, `feat_x` all collapse to `feat_x`), which would
 * point distinct branches at the same on-device dir and restore the wrong work
 * (Codex P1 on the checkpoint store). The FNV-1a hash of the EXACT value is the
 * collision-free part; the sanitized prefix is only for human-readable dirs.
 */

/** Cosmetic, path-safe prefix for an on-device dir (NOT the uniqueness key). */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
}

/** FNV-1a 32-bit hex of the exact value — the collision-free part of the key. */
export function laneHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** `<sanitized>-<hash>` — a filesystem-safe, collision-free dir segment for `value`. */
export function laneSegment(value: string): string {
  return `${sanitizeSegment(value)}-${laneHash(value)}`;
}
