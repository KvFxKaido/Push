/**
 * audit-provenance.ts — map a daemon request context to audit attribution.
 *
 * Extracted with the Phase 2 execution handlers because sandbox execution and
 * later device-admin handlers share this mapping. Keeping it below both handler
 * families avoids duplication and preserves the one-way module graph.
 */
import type { AuditAuthKind, AuditSurface } from '../pushd-audit-log.js';
import type { DaemonHandlerContext } from './handler-types.js';

export interface AuditProvenance {
  surface: AuditSurface;
  deviceId?: string;
  attachTokenId?: string;
  authKind?: AuditAuthKind;
}

/**
 * Extract the provenance fields the audit log expects from the dispatcher
 * context. Handlers call this once and spread the result into
 * `appendAuditEvent`. `surface` defaults to 'unix-socket' because handlers
 * reachable from BOTH transports get called from the CLI's local Unix-socket
 * path when no WS context is present.
 */
export function auditProvenance(
  context: Pick<DaemonHandlerContext, 'auth'> | null | undefined,
): AuditProvenance {
  const auth = context?.auth;
  if (!auth) return { surface: 'unix-socket' };
  return {
    surface: 'ws',
    deviceId: auth.parentDeviceTokenId,
    attachTokenId: auth.kind === 'attach' ? auth.tokenId : undefined,
    authKind: auth.kind,
  };
}
