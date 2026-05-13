/**
 * pushd-relay-allowlist.ts — In-process map of attach-token hashes
 * pushd has minted, used to build the `relay_phone_allow` /
 * `relay_phone_revoke` envelopes the relay's per-session DO uses to
 * gate forwarding.
 *
 * Value stored per entry: `sha256(bearer)` base64url-encoded — the
 * same hash the attach-token store persists at mint time. Bearer
 * plaintext is never held here. That's what makes daemon-restart
 * recovery work: at boot, pushd seeds this registry from the
 * persisted hash store (`listDeviceAttachTokens()`), then re-emits
 * a full `relay_phone_allow` on every `relay.connect`. Pre-hash
 * builds carried bearer plaintext, which couldn't survive a restart.
 *
 * Lifecycle:
 *   - At daemon startup, `pushd.ts#seedRelayAllowlistFromAttachTokens`
 *     walks every unexpired attach-token record and calls
 *     `add(tokenId, tokenHash)` for each.
 *   - At `mint_device_attach_token`, the handler calls `add(tokenId,
 *     record.tokenHash)` with the freshly-minted record (the bearer
 *     plaintext is also in scope at that moment, but we never store it
 *     — only the hash).
 *   - At `revoke_device_attach_token` or cascade from
 *     `revoke_device_token`, the handler calls `remove(tokenId)`.
 *   - On relay-client `open`, the daemon emits the full
 *     `relay_phone_allow` envelope (`allTokenHashes()`) so a DO that
 *     restarted in the meantime rebuilds its per-session allowlist.
 *
 * Storage: process memory only. Token discipline: this module never
 * holds bearer text. `allTokenHashes()` is the only read path, and
 * the only caller is the relay-emit helper.
 */

export interface RelayAllowlistRegistry {
  /**
   * Record that the bearer whose `sha256` is `tokenHash` is currently
   * valid for the relay path. `tokenHash` should be the same digest
   * the attach-token store persists (sha256 → base64url).
   *
   * Returns true when the entry was actually written; false when
   * the call was a no-op because `tokenId` or `tokenHash` was empty.
   * The seed path uses this to report the number of records it
   * actually allowlisted rather than the number it read, so a
   * malformed-on-disk record (empty hash, etc.) doesn't inflate the
   * startup log.
   */
  add(tokenId: string, tokenHash: string): boolean;
  /** Remove an entry by attach tokenId. Returns the tokenHash that was
   * removed (so the caller can include it in a `relay_phone_revoke`
   * envelope), or null if no entry existed. */
  remove(tokenId: string): string | null;
  /** Remove multiple entries (cascade revoke). Returns the tokenHashes
   * that were actually removed. */
  removeMany(tokenIds: readonly string[]): string[];
  /** Snapshot of every currently-valid tokenHash, in insertion order. */
  allTokenHashes(): string[];
  /** Number of entries currently allowlisted. */
  size(): number;
  /** Test seam: drop everything. Never called from production paths. */
  clear(): void;
}

/**
 * Boot-time helper: walk a list of persisted attach-token records
 * and seed the registry with `(tokenId, tokenHash)` for each. Used
 * by pushd at startup so the in-memory registry survives daemon
 * restarts — without this, the first `relay_phone_allow` re-emit
 * after reboot would be empty and every paired phone would lose
 * forwarding access.
 *
 * Factored out of pushd.ts so the wire-up has a unit test that
 * exercises the registry + the list-fn together without requiring
 * a running daemon.
 */
export async function seedAllowlistFromAttachTokens(
  registry: RelayAllowlistRegistry,
  list: () => Promise<readonly { tokenId: string; tokenHash: string }[]>,
): Promise<number> {
  const records = await list();
  let added = 0;
  for (const r of records) {
    if (registry.add(r.tokenId, r.tokenHash)) added += 1;
  }
  return added;
}

export function createRelayAllowlistRegistry(): RelayAllowlistRegistry {
  // Map keyed by attach tokenId — both `add` and `remove` need the id,
  // and the value is the tokenHash. Insertion order is iteration order
  // (Map guarantee) which keeps `allTokenHashes()` deterministic for tests.
  const byTokenId = new Map<string, string>();

  return {
    add(tokenId, tokenHash) {
      if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
      if (typeof tokenHash !== 'string' || tokenHash.length === 0) return false;
      byTokenId.set(tokenId, tokenHash);
      return true;
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
    allTokenHashes() {
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
