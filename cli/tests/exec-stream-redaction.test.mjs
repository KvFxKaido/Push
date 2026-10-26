// Credential values split across streamed exec output, and the daemon's
// sandbox_exec, which never went through executeToolCall's redaction.
// The #1670 review finding: exec_poll / exec_wait return incremental output,
// and each result was redacted on its own, so a value split across two
// responses matched neither and the model received both halves.
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { createStreamRedactor } from '../secret-redaction.ts';
import { executeToolCall } from '../tools.ts';
import { handleRequest } from '../pushd.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const SECRET = 'PUSH-STREAM-SECRET-4f81c2d9e7';
const HALF = SECRET.slice(0, 14);
const values = [{ value: SECRET, file: '.env' }];

describe('createStreamRedactor', () => {
  it('redacts a value split across two chunks, holding the possible prefix', () => {
    const r = createStreamRedactor(values);
    const first = r.push(`token: ${HALF}`);
    assert.equal(first, 'token: ', 'the possible prefix must be held back');
    const second = r.push(`${SECRET.slice(14)} done\n`);
    assert.equal(second, '[redacted: .env] done\n');
    assert.equal(r.flush(), '');
    assert.equal(r.count, 1);
  });

  it('redacts a value split across three chunks', () => {
    const r = createStreamRedactor(values);
    const out = [r.push(SECRET.slice(0, 5)), r.push(SECRET.slice(5, 20)), r.push(SECRET.slice(20))];
    out.push(r.flush());
    assert.equal(out.join(''), '[redacted: .env]');
  });

  it('releases held text once the next chunk rules the value out', () => {
    const r = createStreamRedactor(values);
    assert.equal(r.push('PUSH-STR'), '');
    assert.equal(r.push('ING-OTHER'), 'PUSH-STRING-OTHER');
    assert.equal(r.count, 0);
  });

  it('redacts a long fragment still held at exit, and emits a short one', () => {
    const long = createStreamRedactor(values);
    long.push(HALF);
    assert.equal(long.flush(), '[redacted partial: .env]');
    const short = createStreamRedactor(values);
    assert.equal(short.push('ok PU'), 'ok ');
    assert.equal(short.flush(), 'PU');
  });

  it('passes text through untouched with no values', () => {
    const r = createStreamRedactor([]);
    assert.equal(r.push(HALF), HALF);
  });
});

describe('exec session streams (exec_start / exec_poll / exec_wait)', () => {
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-stream-redact-'));
    await fs.writeFile(path.join(root, '.env'), `API_KEY=${SECRET}\n`, 'utf8');
    // Prints the value in two writes with a gap, so it lands in two chunks and
    // a poll between them sees only the first half.
    await fs.writeFile(
      path.join(root, 'split.cjs'),
      `process.stdout.write('key=${HALF}');\nsetTimeout(() => process.stdout.write('${SECRET.slice(14)}\\n'), 2500);\n`,
      'utf8',
    );
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('never returns either half of a value printed across two polls', async () => {
    const started = await executeToolCall(
      { tool: 'exec_start', args: { command: 'node split.cjs' } },
      root,
      { role: 'coder', allowExec: true },
    );
    assert.equal(started.ok, true, started.text);
    const sessionId = started.meta.session_id;

    // Poll until the first write has been stored (seq ≥ 1), before the second
    // lands 2.5s later — a fixed sleep raced Node's startup on Windows and
    // polled before any output, which hid the split entirely.
    let mid;
    for (let i = 0; i < 40; i++) {
      mid = await executeToolCall(
        { tool: 'exec_poll', args: { session_id: sessionId, from_seq: 0 } },
        root,
        { role: 'coder', allowExec: true },
      );
      if (mid.meta.next_seq >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(mid.meta.next_seq >= 1, 'first write never arrived');
    assert.equal(mid.meta.running, true, 'the second write must still be pending');
    assert.ok(!mid.text.includes(HALF), `first half leaked mid-stream: ${mid.text}`);

    // Continue from where that poll left off, as a model does: this response
    // holds only the rest of the stream.
    const done = await executeToolCall(
      {
        tool: 'exec_wait',
        args: { session_id: sessionId, from_seq: mid.meta.next_seq, timeout_ms: 10_000 },
      },
      root,
      { role: 'coder', allowExec: true },
    );
    assert.equal(done.meta.waited, 'exited', done.text);
    assert.ok(!JSON.stringify(done).includes(HALF), `value leaked: ${done.text}`);
    assert.ok(!JSON.stringify(done).includes(SECRET.slice(14)), `second half leaked: ${done.text}`);
    assert.ok(done.text.includes('[redacted: .env]'), done.text);
    assert.ok(mid.text.includes('key='), 'ordinary output before the value was dropped');
  });
});

describe('daemon sandbox_exec', () => {
  let dir;
  const request = (payload) => ({
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_redact_${Math.random().toString(36).slice(2, 8)}`,
    type: 'sandbox_exec',
    sessionId: null,
    payload,
  });

  before(async () => {
    // Inside process.cwd(): the daemon's implicit allowlist root.
    dir = await fs.mkdtemp(path.join(process.cwd(), '.push-test-redact-'));
    await fs.writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\n`, 'utf8');
    await fs.writeFile(
      path.join(dir, 'print.cjs'),
      "const v = require('fs').readFileSync('.env', 'utf8');\n" +
        "if (process.argv[2] === 'err') { process.stderr.write(v); process.exit(3); }\n" +
        'process.stdout.write(v);\n',
      'utf8',
    );
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('scrubs credential values from stdout', async () => {
    const res = await handleRequest(request({ command: 'node print.cjs', cwd: dir }), () => {});
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.payload.exitCode, 0, JSON.stringify(res.payload));
    assert.ok(!res.payload.stdout.includes(SECRET), `secret leaked: ${res.payload.stdout}`);
    assert.match(res.payload.stdout, /\[redacted: [^\]]*\.env\]/);
  });

  it('scrubs credential values from stderr on a failing command too', async () => {
    const res = await handleRequest(request({ command: 'node print.cjs err', cwd: dir }), () => {});
    assert.equal(res.payload.exitCode, 3, JSON.stringify(res.payload));
    assert.ok(!JSON.stringify(res.payload).includes(SECRET), JSON.stringify(res.payload));
    assert.match(res.payload.stderr, /\[redacted: [^\]]*\.env\]/);
  });
});

describe('review follow-ups (#1695)', () => {
  it('a fast command still closes its session when the credential walk is slow', async () => {
    // Codex P1: the value snapshot was awaited between spawn and listener
    // registration, so a command that exited during a slow walk left the
    // session `running` forever. A shell builtin exits near-instantly and 1,500
    // credential-bearing dirs slow the walk; with Node as the command (or 200
    // dirs) the gap never opened on Windows and this test passed with the bug.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-race-'));
    try {
      await Promise.all(
        Array.from({ length: 1500 }, async (_, i) => {
          const dir = path.join(root, `d${i}`);
          await fs.mkdir(dir);
          await fs.writeFile(path.join(dir, '.env'), `K=value-number-${i}-padding\n`, 'utf8');
        }),
      );
      const opts = { role: 'coder', allowExec: true };
      const started = await executeToolCall(
        { tool: 'exec_start', args: { command: 'exit 0' } },
        root,
        opts,
      );
      assert.equal(started.ok, true, started.text);
      const waited = await executeToolCall(
        {
          tool: 'exec_wait',
          args: { session_id: started.meta.session_id, from_seq: 0, timeout_ms: 8_000 },
        },
        root,
        opts,
      );
      assert.equal(waited.meta.waited, 'exited', waited.text);
      assert.equal(waited.meta.exit_code, 0, waited.text);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('daemon sandbox_exec scrubs values from an allowlisted parent root too', async () => {
    // With both /work and /work/project allowed, a command in the project can
    // read /work/.env; scanning only the deepest root missed it.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'push-nested-'));
    const work = path.join(base, 'work');
    const project = path.join(work, 'project');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(work, '.env'), `API_KEY=${SECRET}\n`, 'utf8');
    await fs.writeFile(
      path.join(project, 'up.cjs'),
      "process.stdout.write(require('fs').readFileSync('../.env', 'utf8'));\n",
      'utf8',
    );
    const allowlist = path.join(base, 'pushd.allowlist');
    await fs.writeFile(
      allowlist,
      `${JSON.stringify({ path: work, addedAt: 1 })}\n${JSON.stringify({ path: project, addedAt: 2 })}\n`,
      'utf8',
    );
    const prev = process.env.PUSHD_ALLOWLIST_PATH;
    process.env.PUSHD_ALLOWLIST_PATH = allowlist;
    try {
      const res = await handleRequest(
        {
          v: PROTOCOL_VERSION,
          kind: 'request',
          requestId: 'req_test_nested',
          type: 'sandbox_exec',
          sessionId: null,
          payload: { command: 'node up.cjs', cwd: project },
        },
        () => {},
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.payload.exitCode, 0, JSON.stringify(res.payload));
      assert.ok(!res.payload.stdout.includes(SECRET), `secret leaked: ${res.payload.stdout}`);
      assert.match(res.payload.stdout, /\[redacted: [^\]]*\.env\]/);
    } finally {
      if (prev === undefined) delete process.env.PUSHD_ALLOWLIST_PATH;
      else process.env.PUSHD_ALLOWLIST_PATH = prev;
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });
});
