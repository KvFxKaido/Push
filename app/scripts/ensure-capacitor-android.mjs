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

// Regenerate Android launcher icons from app/assets/ via capacitor-assets.
// Only runs after a fresh `cap add android` so we don't clobber any local
// custom assets every time someone runs `android:setup`. CI invokes this on
// every clean bootstrap so the produced APK ships with the project's icon
// instead of the generic Capacitor default.
function regenerateAndroidIcons() {
  const assetsDir = join(appRoot, 'assets');
  const hasIconSource =
    existsSync(join(assetsDir, 'icon-foreground.png')) ||
    existsSync(join(assetsDir, 'icon-only.png'));
  if (!hasIconSource) return;

  const capAssetsBin = join(
    appRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'capacitor-assets.cmd' : 'capacitor-assets',
  );
  if (!existsSync(capAssetsBin)) {
    console.warn(
      'Skipping icon regen: @capacitor/assets is not installed. Run `npm --prefix app install` to enable.',
    );
    return;
  }

  console.log('Regenerating Android launcher icons via @capacitor/assets.');
  const result = spawnSync(capAssetsBin, ['generate', '--android'], {
    cwd: appRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) {
    console.warn('@capacitor/assets exited non-zero; continuing with default icons.');
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

const justCreatedAndroidDir = !existsSync(androidGradleFile);
if (justCreatedAndroidDir) {
  runCapAddAndroid();
}

patchProguardFile();

if (justCreatedAndroidDir) {
  regenerateAndroidIcons();
}
