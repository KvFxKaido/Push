import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
