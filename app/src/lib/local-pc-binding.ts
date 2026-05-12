/**
 * local-pc-binding.ts — Helpers for the Local PC workspace mode.
 *
 * The `LocalPcBinding` type itself lives in `@/types` alongside the
 * `WorkspaceSession` union so the transport boundary is one read away
 * from the session shape. This module holds the flag check, loopback
 * defaults, and small predicates used by the UI layer.
 *
 * PR 3b scope: pairing UX + storage + a probe screen that proves the
 * WS round-trip. The chat round loop and tool dispatch stay on the
 * cloud sandbox path. PR 3c rewires those.
 */
import type { WorkspaceSession } from '@/types';

/**
 * The pushd WS listener hard-binds to 127.0.0.1; the web adapter
 * refuses non-loopback hosts at construction time. The pairing UI
 * exposes the port as the only network input so a user can't paste
 * a remote host by accident.
 */
export const LOCAL_PC_HOST = '127.0.0.1';

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Feature flag for the Local PC entry point. The hub tile, route
 * screen, and any other surface that exposes the mode reads this.
 * Default OFF so the experimental path doesn't leak into mainline
 * builds. Matches the `VITE_*` flag pattern used elsewhere in
 * `app/src/lib/`.
 *
 * Reads from `process.env` first (so vitest's `stubEnv` / a Node
 * runtime can drive it) and falls back to `import.meta.env`. Vite
 * inlines `import.meta.env.VITE_*` at build time, so production
 * browser builds resolve via the second branch; tests reach it via
 * the first.
 */
export function isLocalPcModeEnabled(): boolean {
  const raw = readFlag();
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readFlag(): string | boolean | undefined {
  if (typeof process !== 'undefined' && process.env?.VITE_LOCAL_PC_MODE !== undefined) {
    return process.env.VITE_LOCAL_PC_MODE;
  }
  const meta = (import.meta as ImportMeta & { env?: { VITE_LOCAL_PC_MODE?: string | boolean } })
    .env;
  return meta?.VITE_LOCAL_PC_MODE;
}

/** True if the provided port string parses as a valid TCP port. */
export function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value.trim())) return false;
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

/**
 * Type guard for the local-pc arm of WorkspaceSession. Keeps call
 * sites honest: callers must narrow before touching `.binding`, which
 * means missing-binding-means-cloud stays a compile-time guarantee.
 */
export function isLocalPcSession(
  session: WorkspaceSession,
): session is Extract<WorkspaceSession, { kind: 'local-pc' }> {
  return session.kind === 'local-pc';
}
