import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { AUDITOR_GATE_ENV_VAR } from '../lib/auditor-policy.js';

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
  scrub?: ScrubConfig;
  ollama?: ProviderConfig;
  openrouter?: ProviderConfig;
  zen?: ProviderConfig;
  nvidia?: ProviderConfig;
  kilocode?: ProviderConfig;
  blackbox?: ProviderConfig;
  openadapter?: ProviderConfig;
  openai?: ProviderConfig;
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
  setEnvIfMissing('PUSH_EXEC_MODE', config.execMode);
  setEnvIfMissing('PUSH_THEME', config.theme);
  setEnvIfMissing('PUSH_SPINNER', config.spinner);

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

  const ollama = ensureObject(config.ollama) as ProviderConfig;
  setEnvIfMissing('PUSH_OLLAMA_URL', ollama.url);
  setEnvIfMissing('PUSH_OLLAMA_API_KEY', ollama.apiKey);
  setEnvIfMissing('PUSH_OLLAMA_MODEL', ollama.model);

  const openrouter = ensureObject(config.openrouter) as ProviderConfig;
  setEnvIfMissing('PUSH_OPENROUTER_URL', openrouter.url);
  setEnvIfMissing('PUSH_OPENROUTER_API_KEY', openrouter.apiKey);
  setEnvIfMissing('PUSH_OPENROUTER_MODEL', openrouter.model);

  const zen = ensureObject(config.zen) as ProviderConfig;
  setEnvIfMissing('PUSH_ZEN_URL', zen.url);
  setEnvIfMissing('PUSH_ZEN_API_KEY', zen.apiKey);
  setEnvIfMissing('PUSH_ZEN_MODEL', zen.model);

  const nvidia = ensureObject(config.nvidia) as ProviderConfig;
  setEnvIfMissing('PUSH_NVIDIA_URL', nvidia.url);
  setEnvIfMissing('PUSH_NVIDIA_API_KEY', nvidia.apiKey);
  setEnvIfMissing('PUSH_NVIDIA_MODEL', nvidia.model);

  const kilocode = ensureObject(config.kilocode) as ProviderConfig;
  setEnvIfMissing('PUSH_KILOCODE_URL', kilocode.url);
  setEnvIfMissing('PUSH_KILOCODE_API_KEY', kilocode.apiKey);
  setEnvIfMissing('PUSH_KILOCODE_MODEL', kilocode.model);

  const blackbox = ensureObject(config.blackbox) as ProviderConfig;
  setEnvIfMissing('PUSH_BLACKBOX_URL', blackbox.url);
  setEnvIfMissing('PUSH_BLACKBOX_API_KEY', blackbox.apiKey);
  setEnvIfMissing('PUSH_BLACKBOX_MODEL', blackbox.model);

  const openadapter = ensureObject(config.openadapter) as ProviderConfig;
  setEnvIfMissing('PUSH_OPENADAPTER_URL', openadapter.url);
  setEnvIfMissing('PUSH_OPENADAPTER_API_KEY', openadapter.apiKey);
  setEnvIfMissing('PUSH_OPENADAPTER_MODEL', openadapter.model);

  const openai = ensureObject(config.openai) as ProviderConfig;
  setEnvIfMissing('PUSH_OPENAI_URL', openai.url);
  setEnvIfMissing('PUSH_OPENAI_API_KEY', openai.apiKey);
  setEnvIfMissing('PUSH_OPENAI_MODEL', openai.model);

  const anthropic = ensureObject(config.anthropic) as ProviderConfig;
  setEnvIfMissing('PUSH_ANTHROPIC_URL', anthropic.url);
  setEnvIfMissing('PUSH_ANTHROPIC_API_KEY', anthropic.apiKey);
  setEnvIfMissing('PUSH_ANTHROPIC_MODEL', anthropic.model);

  const google = ensureObject(config.google) as ProviderConfig;
  setEnvIfMissing('PUSH_GOOGLE_URL', google.url);
  setEnvIfMissing('PUSH_GOOGLE_API_KEY', google.apiKey);
  setEnvIfMissing('PUSH_GOOGLE_MODEL', google.model);
}

export function maskSecret(value: unknown): string {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
