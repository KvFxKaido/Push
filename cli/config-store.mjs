import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function ensureObject(value) {
  return value && typeof value === 'object' ? value : {};
}

export function getConfigPath() {
  return process.env.PUSH_CONFIG_PATH || path.join(os.homedir(), '.push', 'config.json');
}

export async function loadConfig() {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return ensureObject(parsed);
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveConfig(config) {
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

function setEnvIfMissing(key, value) {
  if (!value || process.env[key]) return;
  process.env[key] = String(value);
}

export function applyConfigToEnv(config) {
  const provider = typeof config.provider === 'string' ? config.provider : '';
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
  setEnvIfMissing('PUSH_EXEC_MODE', config.execMode);


  const ollama = ensureObject(config.ollama);
  setEnvIfMissing('PUSH_OLLAMA_URL', ollama.url);
  setEnvIfMissing('PUSH_OLLAMA_API_KEY', ollama.apiKey);
  setEnvIfMissing('PUSH_OLLAMA_MODEL', ollama.model);

  const openrouter = ensureObject(config.openrouter);
  setEnvIfMissing('PUSH_OPENROUTER_URL', openrouter.url);
  setEnvIfMissing('PUSH_OPENROUTER_API_KEY', openrouter.apiKey);
  setEnvIfMissing('PUSH_OPENROUTER_MODEL', openrouter.model);

  const zen = ensureObject(config.zen);
  setEnvIfMissing('PUSH_ZEN_URL', zen.url);
  setEnvIfMissing('PUSH_ZEN_API_KEY', zen.apiKey);
  setEnvIfMissing('PUSH_ZEN_MODEL', zen.model);

  const nvidia = ensureObject(config.nvidia);
  setEnvIfMissing('PUSH_NVIDIA_URL', nvidia.url);
  setEnvIfMissing('PUSH_NVIDIA_API_KEY', nvidia.apiKey);
  setEnvIfMissing('PUSH_NVIDIA_MODEL', nvidia.model);

  const kilocode = ensureObject(config.kilocode);
  setEnvIfMissing('PUSH_KILOCODE_URL', kilocode.url);
  setEnvIfMissing('PUSH_KILOCODE_API_KEY', kilocode.apiKey);
  setEnvIfMissing('PUSH_KILOCODE_MODEL', kilocode.model);

  const blackbox = ensureObject(config.blackbox);
  setEnvIfMissing('PUSH_BLACKBOX_URL', blackbox.url);
  setEnvIfMissing('PUSH_BLACKBOX_API_KEY', blackbox.apiKey);
  setEnvIfMissing('PUSH_BLACKBOX_MODEL', blackbox.model);

  const openadapter = ensureObject(config.openadapter);
  setEnvIfMissing('PUSH_OPENADAPTER_URL', openadapter.url);
  setEnvIfMissing('PUSH_OPENADAPTER_API_KEY', openadapter.apiKey);
  setEnvIfMissing('PUSH_OPENADAPTER_MODEL', openadapter.model);
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
