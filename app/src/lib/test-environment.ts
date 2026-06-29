import http from 'node:http';

export async function canListenOnLoopback(): Promise<boolean> {
  const server = http.createServer((_req, res) => {
    res.end('ok');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).catch(() => {});
  }
}
