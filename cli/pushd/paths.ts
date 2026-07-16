/**
 * paths.ts — pushd socket/PID/port/log path resolution and socket/PID file
 * lifecycle helpers.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Everything
 * here is environment/path resolution or a stateless fs helper over those
 * paths — no daemon runtime state. `cli/pushd.ts` re-exports the public
 * helpers as the compatibility facade.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function getDefaultWindowsPipePath(): string {
  const rawUser = process.env.USERNAME || process.env.USER || 'user';
  const safeUser = String(rawUser).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `\\\\.\\pipe\\pushd-${safeUser}`;
}

export function isNamedPipePath(targetPath: unknown): boolean {
  return typeof targetPath === 'string' && targetPath.startsWith('\\\\.\\pipe\\');
}

export function getSocketPath(): string {
  if (process.env.PUSHD_SOCKET) return process.env.PUSHD_SOCKET;
  if (process.platform === 'win32') return getDefaultWindowsPipePath();
  const pushDir = path.join(os.homedir(), '.push', 'run');
  return path.join(pushDir, 'pushd.sock');
}

export function getPidPath(): string {
  return path.join(os.homedir(), '.push', 'run', 'pushd.pid');
}

export function getPortPath(): string {
  if (process.env.PUSHD_PORT_PATH) return process.env.PUSHD_PORT_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.port');
}

export function isWsListenerEnabled(): boolean {
  // PR 1: WS listener is dormant by default. Internal-dogfooding flag —
  // the listener is loopback-only and token-gated either way, but the
  // flag lets us harden the auth path before exposing it.
  const raw = process.env.PUSHD_WS;
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function getLogPath(): string {
  if (process.env.PUSHD_LOG) return process.env.PUSHD_LOG;
  return path.join(os.homedir(), '.push', 'run', 'pushd.log');
}

export async function writePidFile(): Promise<void> {
  const pidPath = getPidPath();
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, String(process.pid), 'utf8');
}

export async function cleanPidFile(): Promise<void> {
  try {
    await fs.unlink(getPidPath());
  } catch {
    /* ignore */
  }
}

export async function ensureSocketDir(socketPath: string): Promise<void> {
  if (isNamedPipePath(socketPath)) return;
  const dir = path.dirname(socketPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

export async function cleanStaleSocket(socketPath: string): Promise<void> {
  if (isNamedPipePath(socketPath)) return;
  try {
    await fs.unlink(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
