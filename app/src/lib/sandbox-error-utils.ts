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
