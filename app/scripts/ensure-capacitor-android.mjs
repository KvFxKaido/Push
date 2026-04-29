import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function runCapAddAndroid() {
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

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Capacitor's generated app/android/app/build.gradle still references
// `proguard-android.txt`, which AGP 9+ rejects (it shipped `-dontoptimize`).
// We patch the line on every run so a stale local checkout self-heals and
// doesn't require a manual fix after every `cap add android`. Idempotent —
// no-op when already patched.
function patchProguardFile() {
  if (!existsSync(androidGradleFile)) return;
  const original = readFileSync(androidGradleFile, 'utf8');
  const patched = original.replace(
    /getDefaultProguardFile\((['"])proguard-android\.txt\1\)/g,
    "getDefaultProguardFile('proguard-android-optimize.txt')",
  );
  if (patched !== original) {
    writeFileSync(androidGradleFile, patched);
    console.log(
      'Patched android/app/build.gradle: proguard-android.txt → proguard-android-optimize.txt',
    );
  }
}

if (!existsSync(androidGradleFile)) {
  runCapAddAndroid();
}

patchProguardFile();
