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
    process.env.PUSH_EXPLAIN_MODE = String(config.explainMode);
  }
  setEnvIfMissing('PUSH_TAVILY_API_KEY', config.tavilyApiKey);
  setEnvIfMissing('PUSH_WEB_SEARCH_BACKEND', config.webSearchBackend);
  setEnvIfMissing('PUSH_EXEC_MODE', config.execMode);


  const ollama = ensureObject(config.ollama);
  setEnvIfMissing('PUSH_OLLAMA_URL', ollama.url);
  setEnvIfMissing('PUSH_OLLAMA_API_KEY', ollama.apiKey);
  setEnvIfMissing('PUSH_OLLAMA_MODEL', ollama.model);

  const mistral = ensureObject(config.mistral);
  setEnvIfMissing('PUSH_MISTRAL_URL', mistral.url);
  setEnvIfMissing('PUSH_MISTRAL_API_KEY', mistral.apiKey);
  setEnvIfMissing('PUSH_MISTRAL_MODEL', mistral.model);

  const openrouter = ensureObject(config.openrouter);
  setEnvIfMissing('PUSH_OPENROUTER_URL', openrouter.url);
  setEnvIfMissing('PUSH_OPENROUTER_API_KEY', openrouter.apiKey);
  setEnvIfMissing('PUSH_OPENROUTER_MODEL', openrouter.model);

  const zai = ensureObject(config.zai);
  setEnvIfMissing('PUSH_ZAI_URL', zai.url);
  setEnvIfMissing('PUSH_ZAI_API_KEY', zai.apiKey);
  setEnvIfMissing('PUSH_ZAI_MODEL', zai.model);

  const google = ensureObject(config.google);
  setEnvIfMissing('PUSH_GOOGLE_URL', google.url);
  setEnvIfMissing('PUSH_GOOGLE_API_KEY', google.apiKey);
  setEnvIfMissing('PUSH_GOOGLE_MODEL', google.model);

  const minimax = ensureObject(config.minimax);
  setEnvIfMissing('PUSH_MINIMAX_URL', minimax.url);
  setEnvIfMissing('PUSH_MINIMAX_API_KEY', minimax.apiKey);
  setEnvIfMissing('PUSH_MINIMAX_MODEL', minimax.model);

  const zen = ensureObject(config.zen);
  setEnvIfMissing('PUSH_ZEN_URL', zen.url);
  setEnvIfMissing('PUSH_ZEN_API_KEY', zen.apiKey);
  setEnvIfMissing('PUSH_ZEN_MODEL', zen.model);
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
