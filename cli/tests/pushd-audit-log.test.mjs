/**
 * pushd-audit-log.test.mjs — Coverage for the Phase 3 slice 3 audit
 * log storage module.
 *
 * Exercises:
 *   - append round-trips one event through to read
 *   - schema version is stamped (`v`) and rejected on read for older
 *     unknown versions
 *   - tail / sinceMs / type filters
 *   - rotation: live → .1 when size cap exceeded, oldest dropped
 *   - kill switch via PUSHD_AUDIT_ENABLED=0
 *   - truncateForAudit caps strings at AUDIT_COMMAND_MAX_LEN
 *   - file mode is 0600
 *   - shouldLogCommandText respects PUSHD_AUDIT_LOG_COMMANDS env
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  appendAuditEvent,
  readAuditEvents,
  truncateForAudit,
  shouldLogCommandText,
  isAuditEnabled,
  getAuditMaxBytes,
  getAuditMaxFiles,
  __test__,
} from '../pushd-audit-log.ts';

let tmpDir;
let originalEnv = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-audit-test-'));
  originalEnv = {
    PUSHD_AUDIT_LOG_PATH: process.env.PUSHD_AUDIT_LOG_PATH,
    PUSHD_AUDIT_MAX_BYTES: process.env.PUSHD_AUDIT_MAX_BYTES,
    PUSHD_AUDIT_MAX_FILES: process.env.PUSHD_AUDIT_MAX_FILES,
    PUSHD_AUDIT_ENABLED: process.env.PUSHD_AUDIT_ENABLED,
    PUSHD_AUDIT_LOG_COMMANDS: process.env.PUSHD_AUDIT_LOG_COMMANDS,
  };
  process.env.PUSHD_AUDIT_LOG_PATH = path.join(tmpDir, 'pushd.audit.log');
  delete process.env.PUSHD_AUDIT_MAX_BYTES;
  delete process.env.PUSHD_AUDIT_MAX_FILES;
  delete process.env.PUSHD_AUDIT_ENABLED;
  delete process.env.PUSHD_AUDIT_LOG_COMMANDS;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('appendAuditEvent + readAuditEvents', () => {
  it('round-trips a single event with the schema version and timestamp filled in', async () => {
    await appendAuditEvent({
      type: 'auth.upgrade',
      surface: 'ws',
      deviceId: 'pdt_test_1',
      authKind: 'device',
    });
    const events = await readAuditEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].v, __test__.SCHEMA_VERSION);
    assert.equal(events[0].type, 'auth.upgrade');
    assert.equal(events[0].deviceId, 'pdt_test_1');
    assert.equal(events[0].authKind, 'device');
    assert.ok(events[0].ts > 0);
  });

  it('persists with mode 0600', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    const stat = await fs.stat(process.env.PUSHD_AUDIT_LOG_PATH);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('appends multiple events as one NDJSON line each', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', deviceId: 'pdt_a' });
    await appendAuditEvent({ type: 'tool.sandbox_exec', surface: 'ws', deviceId: 'pdt_a' });
    await appendAuditEvent({ type: 'auth.revoke_device', surface: 'unix-socket' });
    const raw = await fs.readFile(process.env.PUSHD_AUDIT_LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.v, __test__.SCHEMA_VERSION);
    }
  });

  it('skips corrupted lines on read', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    // Hand-append a malformed line.
    await fs.appendFile(process.env.PUSHD_AUDIT_LOG_PATH, '{not-json}\n', 'utf8');
    await appendAuditEvent({ type: 'tool.sandbox_exec', surface: 'ws' });
    const events = await readAuditEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'auth.upgrade');
    assert.equal(events[1].type, 'tool.sandbox_exec');
  });

  it('drops lines whose schema version does not match', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    // Hand-append a line with a future schema version.
    await fs.appendFile(
      process.env.PUSHD_AUDIT_LOG_PATH,
      `${JSON.stringify({ v: 'push.audit.v2', ts: Date.now(), type: 'auth.upgrade' })}\n`,
      'utf8',
    );
    const events = await readAuditEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].v, __test__.SCHEMA_VERSION);
  });
});

describe('filters', () => {
  it('respects the `tail` option', async () => {
    for (let i = 0; i < 10; i++) {
      await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { i } });
    }
    const events = await readAuditEvents({ tail: 3 });
    assert.equal(events.length, 3);
    // tail returns the LAST N — payload.i should be 7, 8, 9.
    assert.deepEqual(
      events.map((e) => e.payload.i),
      [7, 8, 9],
    );
  });

  it('respects the `sinceMs` filter', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'old' } });
    const cutoff = Date.now() + 1;
    // Sleep to advance Date.now past the cutoff.
    await new Promise((r) => setTimeout(r, 5));
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'new' } });
    const events = await readAuditEvents({ sinceMs: cutoff });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.tag, 'new');
  });

  it('respects the `type` filter', async () => {
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    await appendAuditEvent({ type: 'tool.sandbox_exec', surface: 'ws' });
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    const events = await readAuditEvents({ type: 'auth.upgrade' });
    assert.equal(events.length, 2);
    for (const e of events) assert.equal(e.type, 'auth.upgrade');
  });
});

describe('rotation', () => {
  it('rotates live → .1 when size threshold is exceeded', async () => {
    // Set a tiny threshold so a single appendable line trips rotation.
    process.env.PUSHD_AUDIT_MAX_BYTES = '200';
    // First write: under the cap, lands in live file.
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { i: 0 } });
    // Bump the live file past the cap with a hand-written line so we
    // don't depend on event line length to set up the test state.
    await fs.appendFile(process.env.PUSHD_AUDIT_LOG_PATH, 'x'.repeat(300), 'utf8');
    // Next append must rotate before writing.
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { i: 1 } });
    const liveExists = await fs
      .stat(process.env.PUSHD_AUDIT_LOG_PATH)
      .then(() => true)
      .catch(() => false);
    const rotatedExists = await fs
      .stat(`${process.env.PUSHD_AUDIT_LOG_PATH}.1`)
      .then(() => true)
      .catch(() => false);
    assert.equal(liveExists, true, 'live file recreated post-rotation');
    assert.equal(rotatedExists, true, '.1 written');
  });

  it('drops entries beyond PUSHD_AUDIT_MAX_FILES', async () => {
    process.env.PUSHD_AUDIT_MAX_BYTES = '50';
    process.env.PUSHD_AUDIT_MAX_FILES = '2';
    const livePath = process.env.PUSHD_AUDIT_LOG_PATH;
    // Force several rotations. Each appendAuditEvent + filler creates
    // an oversized live file that gets rotated on the NEXT append.
    for (let i = 0; i < 5; i++) {
      await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { i } });
      await fs.appendFile(livePath, 'x'.repeat(100), 'utf8');
    }
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { i: 999 } });
    // With maxFiles=2, only `.1` and `.2` should exist; `.3+` were
    // dropped by the rotation walker.
    const r1 = await fs
      .stat(`${livePath}.1`)
      .then(() => true)
      .catch(() => false);
    const r2 = await fs
      .stat(`${livePath}.2`)
      .then(() => true)
      .catch(() => false);
    const r3 = await fs
      .stat(`${livePath}.3`)
      .then(() => true)
      .catch(() => false);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(r3, false, 'rotation beyond maxFiles should have been dropped');
  });

  it('reads events from rotated files when includeRotated is true (default)', async () => {
    process.env.PUSHD_AUDIT_MAX_BYTES = '200';
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'before' } });
    await fs.appendFile(process.env.PUSHD_AUDIT_LOG_PATH, 'x'.repeat(300), 'utf8');
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'after' } });
    const events = await readAuditEvents();
    // Both events should be visible — the "before" one is now in .1.
    const tags = events.map((e) => e.payload?.tag).filter(Boolean);
    assert.ok(tags.includes('before'), 'event from rotated file is read');
    assert.ok(tags.includes('after'));
  });

  it('skips rotated files when includeRotated is false', async () => {
    process.env.PUSHD_AUDIT_MAX_BYTES = '200';
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'before' } });
    await fs.appendFile(process.env.PUSHD_AUDIT_LOG_PATH, 'x'.repeat(300), 'utf8');
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws', payload: { tag: 'after' } });
    const events = await readAuditEvents({ includeRotated: false });
    const tags = events.map((e) => e.payload?.tag).filter(Boolean);
    assert.equal(tags.includes('before'), false, 'rotated file is NOT read');
    assert.ok(tags.includes('after'));
  });
});

describe('env knobs', () => {
  it('isAuditEnabled defaults to true', () => {
    delete process.env.PUSHD_AUDIT_ENABLED;
    assert.equal(isAuditEnabled(), true);
  });

  it('isAuditEnabled honors the 0/false kill switch', () => {
    process.env.PUSHD_AUDIT_ENABLED = '0';
    assert.equal(isAuditEnabled(), false);
    process.env.PUSHD_AUDIT_ENABLED = 'false';
    assert.equal(isAuditEnabled(), false);
    process.env.PUSHD_AUDIT_ENABLED = '1';
    assert.equal(isAuditEnabled(), true);
  });

  it('appendAuditEvent is a no-op when disabled', async () => {
    process.env.PUSHD_AUDIT_ENABLED = '0';
    await appendAuditEvent({ type: 'auth.upgrade', surface: 'ws' });
    const exists = await fs
      .stat(process.env.PUSHD_AUDIT_LOG_PATH)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false, 'no file should be created when disabled');
  });

  it('shouldLogCommandText defaults to false', () => {
    delete process.env.PUSHD_AUDIT_LOG_COMMANDS;
    assert.equal(shouldLogCommandText(), false);
  });

  it('shouldLogCommandText honors the 1/true opt-in', () => {
    process.env.PUSHD_AUDIT_LOG_COMMANDS = '1';
    assert.equal(shouldLogCommandText(), true);
    process.env.PUSHD_AUDIT_LOG_COMMANDS = 'true';
    assert.equal(shouldLogCommandText(), true);
    process.env.PUSHD_AUDIT_LOG_COMMANDS = '0';
    assert.equal(shouldLogCommandText(), false);
  });

  it('getAuditMaxBytes returns the default for invalid env values', () => {
    process.env.PUSHD_AUDIT_MAX_BYTES = 'not-a-number';
    assert.equal(getAuditMaxBytes(), __test__.DEFAULT_MAX_BYTES);
    process.env.PUSHD_AUDIT_MAX_BYTES = '-100';
    assert.equal(getAuditMaxBytes(), __test__.DEFAULT_MAX_BYTES);
    process.env.PUSHD_AUDIT_MAX_BYTES = '1000';
    assert.equal(getAuditMaxBytes(), 1000);
  });

  it('getAuditMaxFiles returns the default for invalid env values', () => {
    process.env.PUSHD_AUDIT_MAX_FILES = 'nope';
    assert.equal(getAuditMaxFiles(), __test__.DEFAULT_MAX_FILES);
    process.env.PUSHD_AUDIT_MAX_FILES = '0';
    assert.equal(getAuditMaxFiles(), __test__.DEFAULT_MAX_FILES);
    process.env.PUSHD_AUDIT_MAX_FILES = '2';
    assert.equal(getAuditMaxFiles(), 2);
  });
});

describe('appendAuditEvent failure containment', () => {
  it('does not throw when the payload is non-JSON-serializable (BigInt)', async () => {
    // BigInt round-trip through JSON.stringify throws. The append
    // must catch this and drop the event without propagating —
    // "audit never blocks the operation being audited" is the
    // load-bearing invariant. #520 Copilot review.
    await assert.doesNotReject(
      appendAuditEvent({
        type: 'auth.upgrade',
        surface: 'ws',
        // @ts-expect-error: deliberate non-serializable for the test
        payload: { huge: 1n },
      }),
    );
    // No record should have been written (stringify failed).
    const events = await readAuditEvents();
    assert.equal(events.length, 0);
  });

  it('does not throw when the payload is circular', async () => {
    const circular = { ref: null };
    circular.ref = circular;
    await assert.doesNotReject(
      appendAuditEvent({
        type: 'auth.upgrade',
        surface: 'ws',
        // @ts-expect-error: deliberate circular for the test
        payload: { circular },
      }),
    );
    const events = await readAuditEvents();
    assert.equal(events.length, 0);
  });
});

describe('truncateForAudit', () => {
  it('returns the input unchanged when under the cap', () => {
    assert.equal(truncateForAudit('short string'), 'short string');
  });

  it('truncates at AUDIT_COMMAND_MAX_LEN including the marker (hard cap)', () => {
    const long = 'x'.repeat(__test__.AUDIT_COMMAND_MAX_LEN + 50);
    const truncated = truncateForAudit(long);
    // Hard cap: total length must NOT exceed MAX_LEN, marker
    // included. The previous shape "first MAX_LEN chars + marker"
    // exceeded the documented limit. #520 Copilot review.
    assert.ok(
      truncated.length <= __test__.AUDIT_COMMAND_MAX_LEN,
      `truncated length ${truncated.length} should be <= ${__test__.AUDIT_COMMAND_MAX_LEN}`,
    );
    assert.ok(truncated.endsWith('…[truncated]'));
  });
});
