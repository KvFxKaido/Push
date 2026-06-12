// Global test bootstrap: keep CLI tests out of the real ~/.push.
//
// Loaded via `--import` in the `test:cli` npm script. Node's test runner
// propagates execArgv to the per-file child processes, so every test file
// process runs this before any test code. Without it, any test that drives
// `saveSessionState` / the engine / the daemon in-process writes session
// dirs straight into the user's `~/.push/sessions` — observed at 2,144
// accumulated dirs (68 MB), ~78% leaked test fixtures, with ~13 more per
// `test:cli` run.
//
// Isolation is layered:
//   1. HOME / USERPROFILE point at a per-process temp dir, so EVERY
//      `os.homedir()`-derived path (`~/.push/sessions`, `~/.push/memory`,
//      `~/.push/config.json`, `~/.push/run/pushd.*`) is contained — for the
//      test process and anything it spawns with inherited env. This is the
//      airtight layer: per-suite env save/restore patterns and background
//      work that outlives a test can't reach the real store, because the
//      real store was never reachable.
//   2. PUSH_SESSION_DIR / PUSH_MEMORY_DIR are ALSO set explicitly, both for
//      grep-ability and so code paths that prefer the explicit override
//      behave the same as in the (pre-existing) per-test isolation setups.
//
// Respects pre-set values: a developer debugging against a specific store
// can set any of these explicitly — this is a default, not an override.
// Temp dirs land under the OS tmpdir (the suite runs with TMPDIR=/tmp per
// the validation contract), so OS tmp cleaning reclaims them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.PUSH_TEST_REAL_HOME) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  if (!process.env.PUSH_SESSION_DIR) {
    process.env.PUSH_SESSION_DIR = path.join(fakeHome, '.push', 'sessions');
  }
  if (!process.env.PUSH_MEMORY_DIR) {
    process.env.PUSH_MEMORY_DIR = path.join(fakeHome, '.push', 'memory');
  }
}
