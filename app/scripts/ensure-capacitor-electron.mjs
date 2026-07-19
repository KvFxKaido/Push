import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// app/electron/ is committed source (mirroring app/android/): the platform
// config, main.ts, and its own pnpm-lock.yaml are tracked, while the
// regenerated halves (synced web bundle, generated/, build/, dist/, vendor/,
// node_modules) are gitignored. See app/README.md "Desktop app" and
// docs/decisions/Windows Desktop — WSL-Hosted Daemon.md (this is the
// scaffolding path for its "native Windows Electron shell" step).
//
// This guard exists because the steps after it in `electron:sync` (cap sync +
// the Electron build) need the platform present AND its deps installed. On a
// fresh clone the scaffold exists but node_modules doesn't, and the failure
// mode without this check is an obscure cap-sync/tsc error rather than the
// exact bootstrap command.
const appRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const electronDir = join(appRoot, 'electron');
const electronPkg = join(electronDir, 'package.json');
const electronDeps = join(electronDir, 'node_modules');

if (!existsSync(electronPkg)) {
  // Defensive: the scaffold is committed, so this only fires on a mangled
  // checkout (partial clone, deleted directory).
  console.error(
    'app/electron/package.json is missing. The Electron shell is committed\n' +
      'source — restore it from git (git checkout -- app/electron) rather than\n' +
      'regenerating via `npx cap add @capawesome/capacitor-electron`, which\n' +
      'would clobber the tracked platform config.',
  );
  process.exit(1);
}

if (!existsSync(electronDeps)) {
  console.error(
    'app/electron/ deps are not installed. The scaffold is committed but the\n' +
      'shell keeps its own dependency tree (it is not a pnpm workspace member):\n' +
      '\n' +
      '  cd electron && pnpm install --ignore-workspace && cd ..\n' +
      '\n' +
      '(--ignore-workspace is load-bearing: a bare `pnpm install` resolves the\n' +
      'repo workspace instead, reports success, and installs none of the\n' +
      'Electron deps.)\n' +
      '\n' +
      'Bundled load (unlike Android): the Electron runtime ignores `server.url`\n' +
      'and serves the synced dist/ copy — re-run `pnpm run electron:sync` after\n' +
      'each web deploy. Remote load only via CAPACITOR_ELECTRON_DEV_SERVER_URL\n' +
      '(dev-server mode, relaxed CSP — not the shipping loader).',
  );
  process.exit(1);
}

// Present — nothing to do. `cap sync @capawesome/capacitor-electron` (run after
// this in `electron:sync`) copies the web bundle and registers plugins.
