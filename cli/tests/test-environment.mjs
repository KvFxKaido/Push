import { execFile } from 'node:child_process';
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
