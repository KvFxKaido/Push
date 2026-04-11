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
