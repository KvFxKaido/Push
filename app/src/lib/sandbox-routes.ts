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
    const namespaceSeparator = rootHost.indexOf('--');

    if (namespaceSeparator <= 0 || namespaceSeparator === rootHost.length - 2) {
      return {
        ok: false,
        code: 'MODAL_URL_INVALID',
        details: `MODAL_SANDBOX_BASE_URL must include the Modal app namespace (got host: ${host})`,
      };
    }

    const namespace = rootHost.slice(0, namespaceSeparator + 2);
    const appOrFunctionName = rootHost.slice(namespaceSeparator + 2);

    for (const fn of new Set(Object.values(SANDBOX_ROUTES))) {
      const suffix = `-${fn}`;
      if (!appOrFunctionName.endsWith(suffix)) {
        continue;
      }

      // Prefer parsing as function URL when it matches a known route suffix,
      // because users commonly paste Modal function URLs from deploy output.
      const appName = appOrFunctionName.slice(0, -suffix.length);
      if (appName.length > 0) {
        return { ok: true, base: `${parsed.protocol}//${namespace}${appName}` };
      }
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
