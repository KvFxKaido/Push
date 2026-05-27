/**
 * Allowlist-based subprocess env policy for model-invoked commands.
 *
 * `applyConfigToEnv()` in `cli/config-store.ts` hydrates `process.env` with
 * provider API keys from `~/.push/config.json` at CLI startup. Without
 * scrubbing, a model emitting `sandbox_exec { command: "env" }` can read
 * every key the daemon holds — `PUSH_ANTHROPIC_API_KEY`,
 * `PUSH_OPENAI_API_KEY`, `GITHUB_TOKEN`, etc.
 *
 * This module produces a filtered env dict that callers pass as
 * `spawn(..., { env })`. Default-deny: only the curated allowlist (and
 * any user extensions via `config.scrub.allow` / `PUSH_SCRUB_ALLOW`)
 * pass through. `PUSH_SCRUB_DISABLED=1` is the documented escape hatch.
 */
import process from 'node:process';

const DEFAULT_ALLOW_KEYS: ReadonlyArray<string> = [
  // POSIX shell + runtime
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'TMPDIR',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  // Windows shell + runtime
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMW6432',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'COMPUTERNAME',
  'WINDIR',
  'TEMP',
  'TMP',
  'PATHEXT',
  // Terminal capabilities (build-tool output formatting)
  'COLORTERM',
  'TERM_PROGRAM',
  'COLUMNS',
  'LINES',
  'FORCE_COLOR',
  'NO_COLOR',
  // CI signal (test runners gate on this)
  'CI',
  // Node toolchain
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_NO_WARNINGS',
  // Python toolchain
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'VIRTUAL_ENV',
  'PIPENV_ACTIVE',
  // Other common toolchains
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  // Docker client config (the container itself does not inherit our env)
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

const DEFAULT_ALLOW_PREFIXES: ReadonlyArray<string> = [
  'LC_',
  'npm_config_',
  'NPM_CONFIG_',
  'BUN_',
];

function parseAllowList(raw: string | undefined): { keys: string[]; prefixes: string[] } {
  const keys: string[] = [];
  const prefixes: string[] = [];
  if (!raw) return { keys, prefixes };
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.endsWith('*')) prefixes.push(trimmed.slice(0, -1));
    else keys.push(trimmed);
  }
  return { keys, prefixes };
}

export interface ScrubOptions {
  source?: NodeJS.ProcessEnv;
  extraAllow?: ReadonlyArray<string>;
  extraAllowPrefixes?: ReadonlyArray<string>;
}

export function scrubEnv(options: ScrubOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const disabledFlag = process.env.PUSH_SCRUB_DISABLED;
  if (disabledFlag === '1' || disabledFlag === 'true') {
    const passthrough: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined) passthrough[k] = v;
    }
    return passthrough;
  }

  const userAllow = parseAllowList(process.env.PUSH_SCRUB_ALLOW);
  const allowKeys = new Set<string>([
    ...DEFAULT_ALLOW_KEYS,
    ...(options.extraAllow ?? []),
    ...userAllow.keys,
  ]);
  const allowPrefixes: string[] = [
    ...DEFAULT_ALLOW_PREFIXES,
    ...(options.extraAllowPrefixes ?? []),
    ...userAllow.prefixes,
  ];

  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (allowKeys.has(k)) {
      out[k] = v;
      continue;
    }
    for (const prefix of allowPrefixes) {
      if (k.startsWith(prefix)) {
        out[k] = v;
        break;
      }
    }
  }
  return out;
}

export const _internalsForTests = { DEFAULT_ALLOW_KEYS, DEFAULT_ALLOW_PREFIXES };
