import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const androidGradleFile = join(appRoot, 'android', 'app', 'build.gradle');
const capBin = join(
  appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'cap.cmd' : 'cap',
);

if (existsSync(androidGradleFile)) {
  process.exit(0);
}

if (!existsSync(capBin)) {
  console.error(
    'Capacitor CLI is not installed in app/node_modules. Run `npm --prefix app install` from the repo root, then retry.',
  );
  process.exit(1);
}

console.log('Android platform not found; running `cap add android`.');

const result = spawnSync(capBin, ['add', 'android'], {
  cwd: appRoot,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
