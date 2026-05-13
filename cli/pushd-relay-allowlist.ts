/**
 * pushd-relay-allowlist.ts — In-process map of attach-token bearers
 * pushd has minted, used to build the `relay_phone_allow` /
 * `relay_phone_revoke` envelopes the relay's per-session DO uses to
 * gate forwarding.
 *
 * Lifecycle:
 *   - At `mint_device_attach_token`, the handler calls `add(tokenId,
 *     bearer)` with the bearer it just minted (the only moment pushd
 *     has the plaintext bearer in scope).
 *   - At `revoke_device_attach_token` or cascade from
 *     `revoke_device_token`, the handler calls `remove(tokenId)`.
 *   - On relay-client `open`, the daemon emits the full
 *     `relay_phone_allow` envelope (`allBearers()`) so a DO that
 *     restarted in the meantime rebuilds its per-session allowlist.
 *
 * Storage: process memory only. Daemon restart clears the registry.
 * That means a phone holding a still-valid attach token across a
 * daemon restart loses relay access until it re-pairs — a known
 * limitation tracked in the decision doc as the follow-up for
 * hash/token-id allowlisting. The choice mirrors the user's call to
 * keep `relay_phone_allow` carrying character-for-character bearers
 * for contract parity with the schema (and the DO's allowlist), and
 * to defer the hash-based hardening to its own slice.
 *
 * Token discipline: this module is the ONLY place outside the WS
 * mint handler that holds attach bearer text. The registry is not
 * exposed via any admin/inspection surface. `allBearers()` is the
 * only read path, and the only caller is the relay-emit helper.
 */

export interface RelayAllowlistRegistry {
  /** Record that `bearer` is currently valid for the relay path. */
  add(tokenId: string, bearer: string): void;
  /** Remove an entry by attach tokenId. Returns the bearer string
   * that was removed (so the caller can include it in a
   * `relay_phone_revoke` envelope), or null if no entry existed. */
  remove(tokenId: string): string | null;
  /** Remove multiple entries (cascade revoke). Returns the bearer
   * strings that were actually removed. */
  removeMany(tokenIds: readonly string[]): string[];
  /** Snapshot of every currently-valid bearer, in insertion order. */
  allBearers(): string[];
  /** Number of bearers currently allowlisted. */
  size(): number;
  /** Test seam: drop everything. Never called from production paths. */
  clear(): void;
}

export function createRelayAllowlistRegistry(): RelayAllowlistRegistry {
  // Map keyed by attach tokenId — both `add` and `remove` need the id,
  // and the bearer is the value. Insertion order is iteration order
  // (Map guarantee) which keeps `allBearers()` deterministic for tests.
  const byTokenId = new Map<string, string>();

  return {
    add(tokenId, bearer) {
      if (typeof tokenId !== 'string' || tokenId.length === 0) return;
      if (typeof bearer !== 'string' || bearer.length === 0) return;
      byTokenId.set(tokenId, bearer);
    },
    remove(tokenId) {
      const existing = byTokenId.get(tokenId);
      if (existing === undefined) return null;
      byTokenId.delete(tokenId);
      return existing;
    },
    removeMany(tokenIds) {
      const removed: string[] = [];
      for (const id of tokenIds) {
        const existing = byTokenId.get(id);
        if (existing === undefined) continue;
        byTokenId.delete(id);
        removed.push(existing);
      }
      return removed;
    },
    allBearers() {
      return Array.from(byTokenId.values());
    },
    size() {
      return byTokenId.size;
    },
    clear() {
      byTokenId.clear();
    },
  };
}
