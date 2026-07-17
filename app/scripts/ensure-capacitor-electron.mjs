import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// app/electron/ is NOT committed yet. Unlike app/android/ (committed source,
// because it carries native customization), the Electron desktop shell is at the
// "config + docs" stage: the deps + scripts + docs are wired here, but the
// generated Capacitor platform scaffold is produced on the local/Windows box
// where the Electron toolchain lives. See
// docs/decisions/Windows Desktop — WSL-Hosted Daemon.md (this is the scaffolding
// path for its "native Windows Electron shell" step).
//
// This guard exists because the steps after it in `electron:sync` (cap sync +
// the Electron build) need the platform present. When it's missing, we stop with
// the exact bootstrap command rather than letting `cap sync` fail obscurely.
const appRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const electronDir = join(appRoot, 'electron');
const electronPkg = join(electronDir, 'package.json');

if (!existsSync(electronPkg)) {
  console.error(
    'app/electron/ is not scaffolded yet. The Electron desktop shell is wired at\n' +
      'the config + docs stage — generate the Capacitor platform locally (where the\n' +
      'Electron toolchain lives), then re-run:\n' +
      '\n' +
      '  npx cap add @capawesome/capacitor-electron\n' +
      '  cd electron && pnpm install --ignore-workspace && cd ..\n' +
      '\n' +
      '(--ignore-workspace is required: app/electron is not a workspace member,\n' +
      'so a bare `pnpm install` resolves the repo workspace, reports success,\n' +
      'and installs none of the Electron deps.)\n' +
      '\n' +
      'Remote-hosted load: the shell follows `server.url` in capacitor.config.ts\n' +
      '(already the hosted Worker), matching the Android shell — no local dist ship.\n' +
      'Add app/electron/ as committed source once it carries real customization\n' +
      '(mirroring app/android/), and gitignore its build outputs + node_modules.',
  );
  process.exit(1);
}

// Present — nothing to do. `cap sync @capawesome/capacitor-electron` (run after
// this in `electron:sync`) copies the web bundle and registers plugins.
