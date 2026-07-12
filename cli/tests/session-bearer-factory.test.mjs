/**
 * session-bearer-factory.test.mjs — Drift guard for the Universal Session
 * Bearer "creation points" audit (docs/decisions/Universal Session Bearer.md).
 *
 * A session is NEVER born tokenless. That holds only if EVERY creation point
 * routes through `createSessionState` (the one helper that mints the attach
 * token) instead of hand-rolling a session literal + `makeSessionId()`.
 *
 * Creation points after Silvery Phase 3:
 *   1. `handleStartSession` — cli/pushd.ts (daemon)
 *   2. `initSession`        — cli/cli.ts (CLI REPL / headless)
 *   3. `initCliSession`     — cli/session-init.ts (Silvery TUI + shared)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const cliDir = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFile(path.join(cliDir, rel), 'utf8');

describe('Universal Session Bearer — creation-point audit', () => {
  it('every creation file imports the factory from session-store', async () => {
    for (const rel of ['pushd.ts', 'cli.ts', 'session-init.ts']) {
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

  it('the CLI creation point (initSession) calls the factory', async () => {
    const src = await read('cli.ts');
    const body = sliceFunction(src, 'async function initSession');
    assert.match(body, /createSessionState\(/, 'initSession must build state via the factory');
  });

  it('the Silvery/shared creation point (initCliSession) calls the factory', async () => {
    const src = await read('session-init.ts');
    assert.match(src, /createSessionState\(/, 'initCliSession must build state via the factory');
  });

  it('Silvery controller creates sessions through initCliSession, not makeSessionId', async () => {
    const src = await read('silvery/controller.ts');
    assert.match(src, /initCliSession|initSession/, 'Silvery must use the shared session init');
    assert.doesNotMatch(
      src,
      /\bmakeSessionId\(/,
      'Silvery must not mint session ids outside the factory',
    );
  });

  it('no creation file mints a session id directly (the inline-creation smell)', async () => {
    for (const rel of ['pushd.ts', 'cli.ts', 'session-init.ts', 'silvery/controller.ts']) {
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
 * `async function`/`function` declaration (or EOF).
 */
function sliceFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `could not find "${signature}" in source`);
  const rest = src.slice(start + signature.length);
  const nextDecl = rest.search(/\n(?:async )?function /);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}
