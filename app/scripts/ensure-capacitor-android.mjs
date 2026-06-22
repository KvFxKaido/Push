import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// app/android/ is committed source now. It outgrew the old regenerate-and-patch
// model when real native customization landed (the capacitor-native-git / JGit
// plugin and its core-library desugaring requirement) — see
// docs/decisions/. This script no longer runs `cap add android` or patches the
// gradle file; both the proguard fix and the desugaring config are committed.
// It just guards that the project is present, because the steps below it in
// `android:sync` (cap sync + the Gradle build) need it. Build outputs and the
// regenerated web bundle are ignored by app/android/.gitignore, not here.
const appRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const androidGradleFile = join(appRoot, 'android', 'app', 'build.gradle');

if (!existsSync(androidGradleFile)) {
  console.error(
    'app/android/ is missing. It is committed source now — restore it with\n' +
      '`git checkout -- app/android`. Do NOT regenerate via `cap add android`:\n' +
      'that would drop the committed native customizations (native-git plugin\n' +
      'registration, core-library desugaring, the proguard fix).',
  );
  process.exit(1);
}

// Present — nothing to do. `npx cap sync android` (run after this in
// `android:sync`) copies the web bundle and registers plugins into the project.
