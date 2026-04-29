/**
 * True only when the message proves the container is gone (expired,
 * terminated, or the Modal app isn't deployed at all). Transient signals —
 * timeouts, cold starts, network blips, rate limits, unauthorized-token
 * races, generic container errors — must NOT trigger sandbox replacement:
 * the sandbox is probably still alive, and recreating it forces a fresh
 * clone that loses all in-flight writes.
 *
 * The sandbox backend's exec endpoint reuses `exit_code: -1` for several
 * non-terminal failures (unauthorized owner token, command timeout, generic
 * container error) in addition to the actual "sandbox not found / expired"
 * case. So an exit_code === -1 alone is NOT proof the container is gone —
 * inspect the accompanying error text via this helper.
 */
export function isDefinitivelyGoneMessage(rawMessage: string | null | undefined): boolean {
  if (!rawMessage) return false;
  const lower = rawMessage.toLowerCase();
  if (lower.includes('modal_not_found')) return true;
  if (lower.includes('sandbox not found')) return true;
  if (lower.includes('sandbox is no longer running')) return true;
  if (lower.includes('sandbox has been terminated')) return true;
  return false;
}

export function isDefinitivelyGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return isDefinitivelyGoneMessage(err.message);
}

export function categorizeSandboxError(raw: string): { title: string; detail: string } {
  const lower = raw.toLowerCase();
  if (lower.includes('clone') || lower.includes('git clone')) {
    return { title: 'Repository clone failed', detail: 'Check repo access and try a new sandbox.' };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('inactivity')) {
    return { title: 'Sandbox timed out', detail: 'The container stopped responding.' };
  }
  if (
    lower.includes('unreachable') ||
    lower.includes('connection refused') ||
    lower.includes('econnrefused')
  ) {
    return { title: 'Sandbox unreachable', detail: 'Could not connect to the container.' };
  }
  // Sandbox session auth failures — check BEFORE the generic GitHub auth
  // match. The CF owner-token scheme surfaces errors like "Owner token does
  // not match (AUTH_FAILURE)" and "Sandbox not found or expired" which
  // contain 'token' and would otherwise misroute users to GitHub Settings
  // when the real problem is an expired sandbox session.
  if (
    lower.includes('auth_failure') ||
    lower.includes('owner token') ||
    lower.includes('sandbox not found') ||
    lower.includes('sandbox_tokens')
  ) {
    return {
      title: 'Sandbox session expired',
      detail: 'Start a new sandbox to continue.',
    };
  }
  if (
    lower.includes('token') ||
    lower.includes('auth') ||
    lower.includes('403') ||
    lower.includes('permission')
  ) {
    return { title: 'Authentication error', detail: 'Check your GitHub token in Settings.' };
  }
  if (lower.includes('memory') || lower.includes('oom')) {
    return { title: 'Out of memory', detail: 'The sandbox ran out of memory.' };
  }
  return {
    title: 'Sandbox error',
    detail: raw.length < 120 ? raw : 'Something went wrong. Start a new sandbox to continue.',
  };
}
