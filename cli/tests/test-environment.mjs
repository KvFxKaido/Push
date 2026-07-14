import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// True on native Windows, where POSIX file-mode bits (chmod 0600/0700) don't
// exist. Tests that assert those are inherently unrunnable here; the canonical
// suite runs on WSL/Linux/CI. Pass `skipOnWindows` as node:test's options arg —
// `it('…', skipOnWindows, fn)` — so a Windows `npm run test:cli` reports
// green-with-skips instead of misleading red (which otherwise buries real
// failures in the noise). Use ONLY for genuinely POSIX-only behavior, never to
// paper over a real Windows portability bug.
export const isWindows = process.platform === 'win32';
export const skipOnWindows = isWindows
  ? { skip: 'POSIX-only file mode; run the CLI suite in WSL/Linux' }
  : {};

// Remove a temp directory that was handed to a session as its workspace root.
//
// Windows locks a directory while any live process has it as cwd; POSIX does
// not. The daemon spawns short-lived `git` children into the workspace root
// and does not await them (`void emitWorkspaceState(...)` at start_session is
// the usual one), so a test that deletes a workspace it just handed to a
// session races those children and a plain rmdir fails EBUSY. It is a race, so
// it only loses under load — which is why it survived every local run and
// first surfaced on the Windows CI leg.
//
// `maxRetries` is Node's documented remedy (it retries EBUSY/EPERM/ENOTEMPTY).
// It tolerates a *transient* handle without hiding a permanent one: a genuinely
// leaked handle still exhausts the retries and throws, so a real regression
// stays red. Do not swap this for a try/catch — that would hide the leak this
// is careful to still surface.
export function rmWorkspace(dir) {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function canCaptureChildStdout() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      'console.log("push-child-ok")',
    ]);
    return stdout.trim() === 'push-child-ok';
  } catch {
    return false;
  }
}

export async function canListenOnLoopback() {
  const server = http.createServer((_req, res) => {
    res.end('ok');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve(undefined));
    }).catch(() => {});
  }
}
