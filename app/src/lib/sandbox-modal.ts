export const SANDBOX_ROUTES = {
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
} as const;

export type SandboxRoute = keyof typeof SANDBOX_ROUTES;

export type ModalSandboxBaseResolution =
  | { ok: true; base: string }
  | { ok: false; code: 'MODAL_URL_INVALID' | 'MODAL_URL_TRAILING_SLASH'; details: string };

/**
 * Normalize MODAL_SANDBOX_BASE_URL into the root app base used to build
 * function endpoints: https://<workspace>--<app>
 *
 * Accepted inputs:
 * - https://<workspace>--<app>
 * - https://<workspace>--<app>.modal.run
 */
export function resolveModalSandboxBase(input: string): ModalSandboxBaseResolution {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL must be a valid https URL (got: ${input.slice(0, 80)})`,
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL must start with https:// (got: ${input.slice(0, 80)})`,
    };
  }

  if (input.trim().endsWith('/')) {
    return {
      ok: false,
      code: 'MODAL_URL_TRAILING_SLASH',
      details: 'MODAL_SANDBOX_BASE_URL must not have a trailing slash. Remove the trailing / and redeploy.',
    };
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: 'MODAL_SANDBOX_BASE_URL must include only the base host (no path, query, or hash).',
    };
  }

  const rootHost = parsed.hostname.endsWith('.modal.run')
    ? parsed.hostname.slice(0, -'.modal.run'.length)
    : parsed.hostname;

  if (!rootHost.includes('--')) {
    return {
      ok: false,
      code: 'MODAL_URL_INVALID',
      details: `MODAL_SANDBOX_BASE_URL must include a Modal app host with "--" (got: ${input.slice(0, 80)})`,
    };
  }

  // Intentionally preserve app names that naturally end with route-like suffixes
  // (e.g. ...--my-create). We only remove the .modal.run domain, never suffix tokens.
  const hostWithOptionalPort = parsed.port ? `${rootHost}:${parsed.port}` : rootHost;
  return { ok: true, base: `${parsed.protocol}//${hostWithOptionalPort}` };
}

export function buildModalFunctionUrl(base: string, modalFunction: string): string {
  return `${base}-${modalFunction}.modal.run`;
}
