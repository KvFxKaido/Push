/**
 * session-bearer-factory.test.mjs — Drift guard for the Universal Session
 * Bearer "3 creation points" audit (docs/decisions/Universal Session Bearer.md).
 *
 * The whole bearer design rests on a single invariant: a session is NEVER
 * born tokenless. That holds only if EVERY creation point routes through
 * `createSessionState` (the one helper that mints the attach token) instead
 * of hand-rolling a session literal + `makeSessionId()`.
 *
 * The audit names exactly three creation points:
 *   1. `handleStartSession`      — cli/pushd.ts (daemon)
 *   2. `createFreshSessionState` — cli/tui.ts   (TUI)
 *   3. `initSession`             — cli/cli.ts    (CLI REPL / headless)
 *
 * This is a SOURCE-level audit (matching the existing disk-load drift guard
 * in daemon-integration.test.mjs) because the TUI/CLI factories are closures
 * inside large entry-point functions and aren't independently importable.
 * The daemon point also has a behavioral test ("start_session persists
 * attachToken" in daemon-integration.test.mjs); the other two are guarded
 * here. If someone reintroduces an inline creation path, they'll re-reach for
 * `makeSessionId()` at the call site — which is exactly what this fails on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const cliDir = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFile(path.join(cliDir, rel), 'utf8');

describe('Universal Session Bearer — creation-point audit', () => {
  it('every creation file imports the factory from session-store', async () => {
    for (const rel of ['pushd.ts', 'tui.ts', 'cli.ts']) {
      const src = await read(rel);
      assert.match(
        src,
        /createSessionState/,
        `${rel} must route session creation through createSessionState`,
      );
    }
  });

  it('the daemon creation point (handleStartSession) calls the factory', async () => {
    const src = await read('pushd.ts');
    const body = sliceFunction(src, 'async function handleStartSession');
    assert.match(
      body,
      /createSessionState\(/,
      'handleStartSession must build state via the factory',
    );
  });

  it('the TUI creation point (createFreshSessionState) calls the factory', async () => {
    const src = await read('tui.ts');
    const body = sliceFunction(src, 'async function createFreshSessionState');
    assert.match(
      body,
      /createSessionState\(/,
      'createFreshSessionState must build state via the factory',
    );
  });

  it('the CLI creation point (initSession) calls the factory', async () => {
    const src = await read('cli.ts');
    const body = sliceFunction(src, 'async function initSession');
    assert.match(body, /createSessionState\(/, 'initSession must build state via the factory');
  });

  it('no creation file mints a session id directly (the inline-creation smell)', async () => {
    // `makeSessionId()` is owned by the factory now. A direct call in any of
    // these three files means a creation path is bypassing the bearer mint —
    // the precise regression the audit exists to catch.
    for (const rel of ['pushd.ts', 'tui.ts', 'cli.ts']) {
      const src = await read(rel);
      const offenders = src
        .split('\n')
        .map((line, idx) => ({ line, n: idx + 1 }))
        .filter(({ line }) => /\bmakeSessionId\(/.test(line));
      assert.equal(
        offenders.length,
        0,
        `${rel} calls makeSessionId() directly (bypasses the factory): ` +
          offenders.map((o) => `L${o.n}: ${o.line.trim()}`).join(' | '),
      );
    }
  });
});

/**
 * Slice a function body from its declaration to the next top-level
 * `async function`/`function` declaration (or EOF). Good enough for a source
 * grep — we only need to scope `createSessionState(` to the right function so
 * an unrelated call elsewhere in the file can't mask a regression.
 */
function sliceFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `could not find "${signature}" in source`);
  const rest = src.slice(start + signature.length);
  const nextDecl = rest.search(/\n(?:async )?function /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}
