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
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

