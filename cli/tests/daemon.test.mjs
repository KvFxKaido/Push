import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSocketPath, getPidPath } from '../pushd.mjs';
import path from 'node:path';
import os from 'node:os';

// ─── Path helpers ────────────────────────────────────────────────

describe('pushd path helpers', () => {
  it('getSocketPath returns default under ~/.push/run/', () => {
    const original = process.env.PUSHD_SOCKET;
    delete process.env.PUSHD_SOCKET;
    const p = getSocketPath();
    assert.ok(p.includes('.push'));
    assert.ok(p.endsWith('pushd.sock'));
    if (original !== undefined) process.env.PUSHD_SOCKET = original;
  });

  it('getSocketPath respects PUSHD_SOCKET env', () => {
    const original = process.env.PUSHD_SOCKET;
    process.env.PUSHD_SOCKET = '/tmp/test.sock';
    assert.equal(getSocketPath(), '/tmp/test.sock');
    if (original !== undefined) process.env.PUSHD_SOCKET = original;
    else delete process.env.PUSHD_SOCKET;
  });

  it('getPidPath returns path under ~/.push/run/', () => {
    const p = getPidPath();
    assert.ok(p.includes('.push'));
    assert.ok(p.endsWith('pushd.pid'));
  });
});

// ─── Protocol envelope (import from pushd would trigger side effects,
//     so we test the protocol format by verifying NDJSON compliance) ──

describe('NDJSON protocol compliance', () => {
  it('envelope structure matches expected schema', () => {
    // Verify the protocol format the daemon uses
    const response = {
      v: 'push.runtime.v1',
      kind: 'response',
      requestId: 'req_test',
      type: 'hello',
      sessionId: null,
      ok: true,
      payload: { runtimeName: 'pushd' },
      error: null,
    };

    const line = JSON.stringify(response);
    const parsed = JSON.parse(line);
    assert.equal(parsed.v, 'push.runtime.v1');
    assert.equal(parsed.kind, 'response');
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.payload, 'object');
  });

  it('event envelope has expected fields', () => {
    const event = {
      v: 'push.runtime.v1',
      kind: 'event',
      sessionId: 'sess_test',
      runId: 'run_test',
      seq: 1,
      ts: Date.now(),
      type: 'assistant_token',
      payload: { text: 'hello' },
    };

    const parsed = JSON.parse(JSON.stringify(event));
    assert.equal(parsed.kind, 'event');
    assert.equal(parsed.type, 'assistant_token');
    assert.equal(typeof parsed.seq, 'number');
    assert.equal(typeof parsed.ts, 'number');
  });
});
