import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { AUDITOR_GATE_ENV_VAR } from '../lib/auditor-policy.js';
import { RUN_TOKEN_BUDGET_ENV_VAR } from '../lib/run-cost-budget.js';
import { POST_EDIT_DIAGNOSTICS_ENV_VAR } from './post-edit-diagnostics.ts';

export interface ProviderConfig {
  url?: string;
  apiKey?: string;
  model?: string;
}

export interface ScrubConfig {
  // Extra env var names (or PREFIX* patterns) to pass through to
  // model-invoked subprocesses (sandbox_exec, exec, exec_start). The
  // built-in allowlist in `cli/env-scrub.ts` already covers common
  // shell + Node/Python/Go/Rust/Docker-client vars; widen here only
  // when a build genuinely needs a project-specific env var.
  allow?: string[];
  // Disable scrubbing entirely. Unsafe — provider API keys hydrated
  // into process.env by `applyConfigToEnv` become visible to every
  // model-invoked subprocess. Intended for local debugging only.
  disabled?: boolean;
}

export interface PushConfig {
  provider?: string;
  localSandbox?: boolean | string;
  explainMode?: boolean | string;
  tavilyApiKey?: string;
  webSearchBackend?: string;
  execMode?: string;
  theme?: string;
  spinner?: string;
  /**
   * TUI mouse handling. "native" (default) leaves mouse selection to the
   * terminal; "app" captures mouse events so Push can wheel-scroll and copy
   * drag-selected transcript text.
   */
  tuiMouseMode?: string;
  /**
   * TUI daemon integration. Defaults to true: the TUI starts pushd
   * when it is not already reachable, then sends turns through it so
   * sessions can persist in the background.
   */
  tuiDaemonAutoStart?: boolean | string;
  // Tool name allow/deny lists (CLI tool names from `cli/tools.ts` — e.g.
  // `exec`, `exec_start`, `write_file`). `disabledTools` blocks at dispatch;
  // `alwaysAllow` waives approval for the listed tools (today only `exec`
  // and `exec_start` actually prompt, so other entries are forward-compat
  // no-ops). Command-prefix allowlisting stays in `safeExecPatterns`.
  alwaysAllow?: string[];
  disabledTools?: string[];
  safeExecPatterns?: string[];
  /**
   * Auditor commit gate. When true (the default — see `lib/auditor-policy.ts`),
   * `git_commit` is routed through the Auditor SAFE/UNSAFE gate before the
   * commit lands. Set false to opt out. Forwarded to child processes (the
   * pushd daemon) as `PUSH_AUDITOR_GATE` by `applyConfigToEnv`.
   */
  auditorGate?: boolean;
  /**
   * Post-edit diagnostics loop. When true (the default), successful
   * `write_file` / `edit_file` results append file-scoped type-checker
   * findings (see `cli/post-edit-diagnostics.ts` for the budget and
   * adaptive-disable guards). Set false to opt out. Forwarded to child
   * processes (the pushd daemon) as `PUSH_POST_EDIT_DIAGNOSTICS` by
   * `applyConfigToEnv`.
   */
  postEditDiagnostics?: boolean;
  /**
   * Per-run token budget — halts a run once it has consumed this many tokens
   * (a consumption circuit breaker complementing `--max-rounds`). Resolved by
   * the shared `lib/run-cost-budget.ts` (env > this setting > off) and
   * forwarded to child processes (the pushd daemon) as `PUSH_RUN_TOKEN_BUDGET`
   * by `applyConfigToEnv`. Omit / 0 ⇒ uncapped.
   */
  runTokenBudget?: number;
  scrub?: ScrubConfig;
  ollama?: ProviderConfig;
  openrouter?: ProviderConfig;
  zen?: ProviderConfig;
  nvidia?: ProviderConfig;
  fireworks?: ProviderConfig;
  deepseek?: ProviderConfig;
  sakana?: ProviderConfig;
  openai?: ProviderConfig;
  xai?: ProviderConfig;
  anthropic?: ProviderConfig;
  google?: ProviderConfig;
  [key: string]: unknown;
}

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function getConfigPath(): string {
  return process.env.PUSH_CONFIG_PATH || path.join(os.homedir(), '.push', 'config.json');
}

export async function loadConfig(): Promise<PushConfig> {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return ensureObject(parsed) as PushConfig;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveConfig(config: PushConfig): Promise<string> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // best effort only
  }
  return configPath;
}

function normalizeConfigEnvValue(value: unknown): string {
  if (typeof value !== 'string') return value ? String(value) : '';
  const normalized = value.trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

function setEnvIfMissing(key: string, value: unknown): void {
  const normalized = normalizeConfigEnvValue(value);
  if (!normalized || process.env[key]) return;
  process.env[key] = normalized;
}

export function applyConfigToEnv(config: PushConfig): void {
  const provider = normalizeConfigEnvValue(config.provider);
  setEnvIfMissing('PUSH_PROVIDER', provider);
  if (config.localSandbox !== undefined) {
    process.env.PUSH_LOCAL_SANDBOX = String(config.localSandbox);
  }
  if (config.explainMode !== undefined) {
    if (!process.env.PUSH_EXPLAIN_MODE) {
      process.env.PUSH_EXPLAIN_MODE = String(config.explainMode);
    }
  }
  setEnvIfMissing('PUSH_TAVILY_API_KEY', config.tavilyApiKey);
  setEnvIfMissing('PUSH_WEB_SEARCH_BACKEND', config.webSearchBackend);
  // Forward the Auditor commit-gate toggle so child processes (notably the
  // pushd daemon's delegated coder tool executor) resolve the same opt-out
  // without re-reading config. Only an explicit setting is forwarded — when
  // unset, the daemon's own resolver applies the default-on.
  if (config.auditorGate !== undefined) {
    setEnvIfMissing(AUDITOR_GATE_ENV_VAR, String(config.auditorGate));
  }
  // Forward the post-edit diagnostics toggle the same way — only an explicit
  // setting is forwarded; when unset, the resolver's default-on applies.
  if (config.postEditDiagnostics !== undefined) {
    setEnvIfMissing(POST_EDIT_DIAGNOSTICS_ENV_VAR, String(config.postEditDiagnostics));
  }
  // Forward the per-run token budget so the daemon's kernel resolves the same
  // cap without re-reading config. Unset → the resolver's default-off applies.
  if (config.runTokenBudget !== undefined) {
    setEnvIfMissing(RUN_TOKEN_BUDGET_ENV_VAR, String(config.runTokenBudget));
  }
  setEnvIfMissing('PUSH_EXEC_MODE', config.execMode);
  setEnvIfMissing('PUSH_THEME', config.theme);
  setEnvIfMissing('PUSH_SPINNER', config.spinner);
  setEnvIfMissing('PUSH_TUI_MOUSE_MODE', config.tuiMouseMode);

  // Forward tool allow/deny lists as comma-separated env vars so child
  // processes (notably the pushd daemon's delegated tool executors) see
  // the same policy without re-reading `~/.push/config.json`. Empty arrays
  // are skipped because there's nothing to communicate — the parser in
  // `cli/tools.ts` already treats unset/empty env vars as "no entries".
  if (Array.isArray(config.disabledTools) && config.disabledTools.length) {
    setEnvIfMissing('PUSH_DISABLED_TOOLS', config.disabledTools.join(','));
  }
  if (Array.isArray(config.alwaysAllow) && config.alwaysAllow.length) {
    setEnvIfMissing('PUSH_ALWAYS_ALLOW', config.alwaysAllow.join(','));
  }

  // Forward the subprocess env-scrub policy to the daemon so that
  // model-invoked execs apply the same allowlist across processes.
  // See `cli/env-scrub.ts` for the policy itself.
  const scrub = ensureObject(config.scrub) as ScrubConfig;
  if (Array.isArray(scrub.allow) && scrub.allow.length) {
    setEnvIfMissing('PUSH_SCRUB_ALLOW', scrub.allow.join(','));
  }
  if (scrub.disabled === true) {
    setEnvIfMissing('PUSH_SCRUB_DISABLED', '1');
  }

  applyProviderEnv(config, false);
}

// Provider config keys whose `url`/`apiKey`/`model` map to the
// `PUSH_<ID>_{URL,API_KEY,MODEL}` env vars consumed by `cli/provider.ts`.
// Single source of truth for both startup application and live reload.
const PROVIDER_CONFIG_KEYS = [
  'ollama',
  'openrouter',
  'zen',
  'nvidia',
  'fireworks',
  'deepseek',
  'sakana',
  'openai',
  'xai',
  'anthropic',
  'google',
] as const;

/**
 * Apply each provider's `url`/`apiKey`/`model` to `PUSH_<ID>_{URL,API_KEY,MODEL}`.
 *
 * `overwrite = false` (startup) defers to any env var already set, so the
 * launching shell wins. `overwrite = true` (an explicit reload after a TUI
 * config edit) forces the on-disk value in, so a long-lived daemon picks up a
 * rotated key without a restart — otherwise `setEnvIfMissing` would keep the
 * stale value the daemon inherited at spawn. Returns the env var names whose
 * value actually changed (names only — never the secrets).
 */
function applyProviderEnv(config: PushConfig, overwrite: boolean): string[] {
  const changed: string[] = [];
  for (const id of PROVIDER_CONFIG_KEYS) {
    const p = ensureObject(config[id]) as ProviderConfig;
    const prefix = `PUSH_${id.toUpperCase()}`;
    const fields: Array<[string, unknown]> = [
      ['URL', p.url],
      ['API_KEY', p.apiKey],
      ['MODEL', p.model],
    ];
    for (const [suffix, raw] of fields) {
      const envKey = `${prefix}_${suffix}`;
      if (!overwrite) {
        setEnvIfMissing(envKey, raw);
        continue;
      }
      // Only force a non-empty value in. A cleared/absent config key is left
      // as-is rather than unset: reload is for rotation, and an empty config
      // value must not clobber a key a launching shell legitimately exported.
      // (Clearing a key to take effect still needs a daemon restart.)
      const normalized = normalizeConfigEnvValue(raw);
      if (normalized && process.env[envKey] !== normalized) {
        process.env[envKey] = normalized;
        changed.push(envKey);
      }
    }
  }
  return changed;
}

/**
 * Force the on-disk provider config into the current process env, overwriting
 * stale values. Used by the pushd `reload_config` verb so a key rotated in the
 * TUI takes effect on the running daemon (which resolves keys live from
 * `process.env` per run) without a restart. Returns the changed env var names.
 */
export function reapplyProviderConfigToEnv(config: PushConfig): string[] {
  const changed = applyProviderEnv(config, true);
  const tavily = normalizeConfigEnvValue(config.tavilyApiKey);
  if (tavily && process.env.PUSH_TAVILY_API_KEY !== tavily) {
    process.env.PUSH_TAVILY_API_KEY = tavily;
    changed.push('PUSH_TAVILY_API_KEY');
  }
  return changed;
}

export function maskSecret(value: unknown): string {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
