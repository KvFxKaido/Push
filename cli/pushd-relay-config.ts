/**
 * pushd-relay-config.ts — Persistent config for the outbound relay
 * dial. Phase 2.e of the remote-sessions track.
 *
 * Stores the deployment-scoped relay bearer + the Worker base URL at
 * `~/.push/run/pushd.relay.json` (chmod 0600). The file holds a
 * single token because the relay is one-pair-per-pushd: pushd dials
 * exactly one Worker deployment. Pairing topology (which phones may
 * attach) is independent and lives in the existing attach-token
 * file.
 *
 * The bearer rides in plaintext (chmod 0600 protects it from other
 * host users). Hashing-at-rest is overkill for a single-token file
 * the daemon needs to read on every startup; it would only obscure
 * the value from a non-attacker reader. Different posture from
 * `pushd.tokens` (where the multi-token allowlist makes hash-only
 * a meaningful gain) on purpose.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export interface RelayConfig {
  /** Worker deployment base URL — `https://` or `wss://`. */
  deploymentUrl: string;
  /** Deployment-scoped bearer, `pushd_relay_<…>`. */
  token: string;
  /** Wall clock ms when `enable` first wrote this config. */
  enabledAt: number;
}

const TOKEN_PREFIX = 'pushd_relay_';

export function getRelayConfigPath(): string {
  if (process.env.PUSHD_RELAY_CONFIG_PATH) return process.env.PUSHD_RELAY_CONFIG_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.relay.json');
}

function getRelayConfigDir(): string {
  return path.dirname(getRelayConfigPath());
}

async function ensureRelayConfigDir(): Promise<void> {
  await fs.mkdir(getRelayConfigDir(), { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(getRelayConfigDir(), 0o700);
  } catch {
    // see pushd-device-tokens.ts — non-POSIX platforms ignore chmod
  }
}

/**
 * Read the persisted relay config, or `null` if no config exists.
 * Returns `null` (rather than throwing) on malformed content too —
 * a hand-corrupted file should not block daemon startup; the operator
 * fixes it by re-running `push daemon relay enable`.
 */
export async function readRelayConfig(): Promise<RelayConfig | null> {
  let raw: string;
  try {
    raw = await fs.readFile(getRelayConfigPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    if (
      typeof parsed.deploymentUrl === 'string' &&
      parsed.deploymentUrl.length > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.startsWith(TOKEN_PREFIX) &&
      typeof parsed.enabledAt === 'number' &&
      Number.isFinite(parsed.enabledAt)
    ) {
      return {
        deploymentUrl: parsed.deploymentUrl,
        token: parsed.token,
        enabledAt: parsed.enabledAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the relay config to disk atomically (tmp + rename) with
 * mode 0600. Overwrites any existing config.
 */
export async function writeRelayConfig(cfg: Omit<RelayConfig, 'enabledAt'>): Promise<RelayConfig> {
  if (typeof cfg.deploymentUrl !== 'string' || cfg.deploymentUrl.length === 0) {
    throw new Error('deploymentUrl is required');
  }
  if (typeof cfg.token !== 'string' || !cfg.token.startsWith(TOKEN_PREFIX)) {
    throw new Error(`token must start with ${TOKEN_PREFIX}`);
  }
  await ensureRelayConfigDir();
  const targetPath = getRelayConfigPath();
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const record: RelayConfig = {
    deploymentUrl: cfg.deploymentUrl,
    token: cfg.token,
    enabledAt: Date.now(),
  };
  const body = `${JSON.stringify(record)}\n`;
  const handle = await fs.open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.chmod(targetPath, 0o600);
  } catch {
    // see ensureRelayConfigDir
  }
  return record;
}

/**
 * Delete the persisted relay config. Returns true if the file was
 * present and removed, false if no file existed.
 */
export async function deleteRelayConfig(): Promise<boolean> {
  try {
    await fs.unlink(getRelayConfigPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = { TOKEN_PREFIX, getRelayConfigPath };
