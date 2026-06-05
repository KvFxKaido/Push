import { describe, expect, it, vi } from 'vitest';
import {
  runDetachedToCompletion,
  type DetachedExecPrimitives,
  type DetachedLogsResult,
  type DetachedStatusResult,
} from './detached-exec-runner.js';

/**
 * Build primitives from scripted status/log sequences. Each poll consumes the
 * next status; logs are served as cumulative slices keyed off the caller's
 * cursor so the runner's incremental draining is exercised for real.
 */
function makePrimitives(opts: {
  statuses: DetachedStatusResult[];
  fullStdout: string;
  startError?: Error;
  statusErrorAt?: number;
}): DetachedExecPrimitives & {
  interrupted: () => boolean;
} {
  let statusCalls = 0;
  let interruptedFlag = false;
  return {
    interrupted: () => interruptedFlag,
    start: vi.fn(async () => {
      if (opts.startError) throw opts.startError;
      return { processId: 'proc_1' };
    }),
    status: vi.fn(async (): Promise<DetachedStatusResult> => {
      const idx = statusCalls++;
      if (opts.statusErrorAt !== undefined && idx === opts.statusErrorAt) {
        const err = new Error('gone') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      return opts.statuses[Math.min(idx, opts.statuses.length - 1)];
    }),
    logs: vi.fn(
      async (
        _id: string,
        cursors: { cursorStdout: number; cursorStderr: number },
      ): Promise<DetachedLogsResult> => {
        // Serve the full buffer; the runner's cursor is what makes each drain
        // incremental, so re-serving from 0 every call exercises that for real.
        const from = Math.min(cursors.cursorStdout, opts.fullStdout.length);
        return {
          stdout: opts.fullStdout.slice(from),
          stderr: '',
          nextCursorStdout: opts.fullStdout.length,
          nextCursorStderr: 0,
        };
      },
    ),
    interrupt: vi.fn(async () => {
      interruptedFlag = true;
    }),
  };
}

describe('runDetachedToCompletion', () => {
  it('drains logs and returns the assembled result on clean exit', async () => {
    const p = makePrimitives({
      statuses: [
        { running: true, exitCode: null },
        { running: false, exitCode: 0 },
      ],
      fullStdout: 'line 1\nline 2\n',
    });

    const result = await runDetachedToCompletion(p, 'npm install', {
      sleep: async () => {},
      now: () => 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('line 1\nline 2\n');
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('fully drains a final burst larger than one capped slice on exit', async () => {
    // The worker caps each logs slice; a single drain on exit would drop the
    // tail beyond the cap. The runner must keep draining a stopped process
    // until the buffer is exhausted. Here `logs` serves at most 3 chars/call.
    const full = 'abcdefgh';
    const primitives: DetachedExecPrimitives = {
      start: async () => ({ processId: 'p' }),
      status: async () => ({ running: false, exitCode: 0 }), // already finished
      logs: async (_id, cursors) => {
        const from = cursors.cursorStdout;
        const next = Math.min(from + 3, full.length); // 3-char cap per call
        return {
          stdout: full.slice(from, next),
          stderr: '',
          nextCursorStdout: next,
          nextCursorStderr: 0,
        };
      },
      interrupt: async () => {},
    };

    const result = await runDetachedToCompletion(primitives, 'cmd', {
      sleep: async () => {},
      now: () => 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(full); // not just the first 3 chars
  });

  it('does not re-emit already-cursored output across polls', async () => {
    const chunks: string[] = [];
    const p = makePrimitives({
      statuses: [
        { running: true, exitCode: null },
        { running: true, exitCode: null },
        { running: false, exitCode: 0 },
      ],
      fullStdout: 'abc',
    });

    const result = await runDetachedToCompletion(p, 'cmd', {
      sleep: async () => {},
      now: () => 0,
      onProgress: (c) => c.stdout && chunks.push(c.stdout),
    });

    // 'abc' is fully drained on the first poll; later polls see nothing new.
    expect(result.stdout).toBe('abc');
    expect(chunks).toEqual(['abc']);
  });

  it('propagates a start failure so callers can fall back to buffered exec', async () => {
    const startError = new Error('no such route') as Error & { statusCode?: number };
    startError.statusCode = 404;
    const p = makePrimitives({ statuses: [], fullStdout: '', startError });

    await expect(
      runDetachedToCompletion(p, 'cmd', { sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow('no such route');
    expect(p.status).not.toHaveBeenCalled();
  });

  it('returns a failure result when the process record disappears mid-run', async () => {
    const p = makePrimitives({
      statuses: [{ running: true, exitCode: null }],
      fullStdout: 'partial',
      statusErrorAt: 1, // first poll ok, second 404s
    });

    const result = await runDetachedToCompletion(p, 'cmd', {
      sleep: async () => {},
      now: () => 0,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.error).toMatch(/disappeared/);
  });

  it('resolves to a failure (never throws) on a non-404 status error mid-run', async () => {
    // The command already started, so a lost-contact status error must NOT
    // propagate — propagating would trip the caller's start-failure fallback
    // and re-run an already-running command.
    const primitives: DetachedExecPrimitives = {
      start: async () => ({ processId: 'p' }),
      status: async () => {
        const err = new Error('upstream 504') as Error & { statusCode?: number };
        err.statusCode = 504;
        throw err;
      },
      logs: async () => ({ stdout: '', stderr: '', nextCursorStdout: 0, nextCursorStderr: 0 }),
      interrupt: async () => {},
    };

    const result = await runDetachedToCompletion(primitives, 'cmd', {
      sleep: async () => {},
      now: () => 0,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.error).toMatch(/lost contact/);
  });

  it('survives a mid-run log-fetch error instead of escaping the loop', async () => {
    // A transient failure on `logs` (404/504/network) must not reject the run
    // nor surface as a start-failure to the caller's fallback — `status` is the
    // authoritative terminal signal, so the loop swallows the slice and goes on.
    let statusCalls = 0;
    let logsCalls = 0;
    const primitives: DetachedExecPrimitives = {
      start: async () => ({ processId: 'p' }),
      status: async () => {
        statusCalls++;
        return statusCalls >= 2
          ? { running: false, exitCode: 0 }
          : { running: true, exitCode: null };
      },
      logs: async (_id, cursors) => {
        logsCalls++;
        if (logsCalls === 1) {
          const err = new Error('logs unavailable') as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err; // first drain blows up mid-run
        }
        const from = Math.min(cursors.cursorStdout, 'ok\n'.length);
        return {
          stdout: 'ok\n'.slice(from),
          stderr: '',
          nextCursorStdout: 'ok\n'.length,
          nextCursorStderr: 0,
        };
      },
      interrupt: async () => {},
    };

    const result = await runDetachedToCompletion(primitives, 'cmd', {
      sleep: async () => {},
      now: () => 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('ok\n'); // recovered on the second drain
  });

  it('reports failure (not exit 0) when a finished process has no exit code', async () => {
    const p = makePrimitives({
      // not running, but exitCode null → killed/errored without recording a code
      statuses: [{ running: false, exitCode: null }],
      fullStdout: 'boom',
    });

    const result = await runDetachedToCompletion(p, 'cmd', {
      sleep: async () => {},
      now: () => 0,
    });

    // Must NOT be 0 — handleCheckTypes gates the install on exitCode !== 0.
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toMatch(/without an exit code/);
  });

  it('does not report a timeout if the process finished right at the deadline', async () => {
    const p = makePrimitives({
      // first poll running; the deadline re-check sees it completed cleanly
      statuses: [
        { running: true, exitCode: null },
        { running: false, exitCode: 0 },
      ],
      fullStdout: 'done\n',
    });

    let t = 0;
    const result = await runDetachedToCompletion(p, 'cmd', {
      overallTimeoutMs: 1000,
      sleep: async () => {},
      now: () => {
        const v = t;
        t += 5000; // second now() read trips the deadline
        return v;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(p.interrupted()).toBe(false); // a completed process is never killed
  });

  it('interrupts and returns 124 when the overall deadline is exceeded', async () => {
    const p = makePrimitives({
      statuses: [{ running: true, exitCode: null }], // never finishes
      fullStdout: 'working...',
    });

    // now() jumps past the deadline on the second read inside the loop.
    let t = 0;
    const result = await runDetachedToCompletion(p, 'cmd', {
      overallTimeoutMs: 1000,
      sleep: async () => {},
      now: () => {
        const v = t;
        t += 5000;
        return v;
      },
    });

    expect(result.exitCode).toBe(124);
    expect(result.error).toMatch(/deadline/);
    expect(p.interrupted()).toBe(true);
  });
});
