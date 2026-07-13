import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const bashAvailable = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
const launcherPath = path.resolve(import.meta.dirname, '..', '..', 'push');

describe('root push launcher freshness', () => {
  it('falls through to the source runtime when a TSX UI file is newer than compiled JS', {
    skip: !bashAvailable && 'bash is unavailable on this platform',
  }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-launcher-staleness-'));
    try {
      const compiled = path.join(root, 'cli', 'dist', 'cli', 'cli.js');
      const surface = path.join(root, 'cli', 'silvery', 'surface.tsx');
      const localTsx = path.join(root, 'node_modules', '.bin', 'tsx');
      const launcher = path.join(root, 'push');

      await fs.mkdir(path.dirname(compiled), { recursive: true });
      await fs.mkdir(path.dirname(surface), { recursive: true });
      await fs.mkdir(path.dirname(localTsx), { recursive: true });
      await fs.copyFile(launcherPath, launcher);
      await fs.writeFile(compiled, '// intentionally stale compiled entry\n');
      await fs.writeFile(surface, '// newer retained-mode UI source\n');
      await fs.writeFile(
        localTsx,
        '#!/usr/bin/env bash\nprintf "tsx:%s:tmpdir=%s\\n" "$*" "${TMPDIR:-}"\n',
      );
      await fs.chmod(launcher, 0o755);
      await fs.chmod(localTsx, 0o755);

      const now = Date.now();
      await fs.utimes(compiled, new Date(now - 10_000), new Date(now - 10_000));
      await fs.utimes(surface, new Date(now), new Date(now));

      const env = {
        ...process.env,
        PUSH_SKIP_STALE_CHECK: '',
        TEMP: '/mnt/c/Users/example/AppData/Local/Temp',
        TMP: '/mnt/c/Users/example/AppData/Local/Temp',
      };
      delete env.TMPDIR;
      const { stdout, stderr } = await execFileAsync('bash', [launcher, '--probe'], {
        cwd: root,
        env,
      });

      assert.match(stdout, /^tsx:.*\/cli\/cli\.ts --probe:tmpdir=\/tmp\n$/);
      assert.match(stderr, /cli\/silvery\/surface\.tsx is newer/);
      assert.match(stderr, /running from source via tsx/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
