export const SANDBOX_ROUTES: Record<string, string> = {
  create: 'create',
  exec: 'exec-command',
  read: 'file-ops',
  write: 'file-ops',
  diff: 'get-diff',
  cleanup: 'cleanup',
  list: 'file-ops',
  delete: 'file-ops',
  restore: 'file-ops',
  'browser-screenshot': 'browser-screenshot',
  'browser-extract': 'browser-extract',
  download: 'create-archive',
};

export function resolveModalSandboxBase(baseUrl: string): { ok: true; base: string } | { ok: false; code: string; details: string } {
  if (!baseUrl.startsWith('https://')) {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL must start with https:// (got: ${baseUrl.slice(0, 50)}...)`,
    };
  }

  if (baseUrl.endsWith('/')) {
    return {
      ok: false,
      code: 'MODAL_URL_TRAILING_SLASH',
      details: 'MODAL_SANDBOX_BASE_URL must not have a trailing slash. Remove the trailing / and redeploy.',
    };
  }

  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname;

    if (!host.endsWith('.modal.run')) {
      if (!host.includes('--')) {
        return {
          ok: false,
          code: 'MODAL_URL_INVALID',
          details: `MODAL_SANDBOX_BASE_URL must include the Modal app namespace (got host: ${host})`,
        };
      }
      return { ok: true, base: `${parsed.protocol}//${host}` };
    }

    const rootHost = host.slice(0, -'.modal.run'.length);
    if (!rootHost.includes('--')) {
      return {
        ok: false,
        code: 'MODAL_URL_INVALID',
        details: `MODAL_SANDBOX_BASE_URL must include the Modal app namespace (got host: ${host})`,
      };
    }

    for (const fn of Object.values(SANDBOX_ROUTES)) {
      const suffix = `-${fn}`;
      if (!rootHost.endsWith(suffix)) continue;

      const candidate = rootHost.slice(0, -suffix.length);
      // Preserve canonical app names that happen to end with route-like words
      // such as "-create" (for example, "alice--my-create.modal.run").
      const candidateAppName = candidate.split('--')[1] ?? '';
      if (!candidateAppName.includes('-')) {
        continue;
      }

      return { ok: true, base: `${parsed.protocol}//${candidate}` };
    }

    return { ok: true, base: `${parsed.protocol}//${rootHost}` };
  } catch {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL is not a valid URL (got: ${baseUrl.slice(0, 50)}...)`,
    };
  }
}
