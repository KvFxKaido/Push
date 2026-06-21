import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRepoLockCount, gitWorkingCopyLockScope, withRepoLock } from './repo-lock.ts';

/** A deferred whose resolution we control, to hold a lock open at will. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // Every test uses unique scope keys, so lanes should always drain to empty.
  // Asserting it here doubles as a no-leak check across the whole suite.
  expect(activeRepoLockCount()).toBe(0);
  vi.restoreAllMocks();
});

describe('gitWorkingCopyLockScope', () => {
  it('namespaces the working-copy id so git locks cannot collide with other keys', () => {
    expect(gitWorkingCopyLockScope('sbx-123')).toBe('git-working-copy:sbx-123');
    expect(gitWorkingCopyLockScope('/home/u/repo')).toBe('git-working-copy:/home/u/repo');
  });
});

describe('withRepoLock — serialization', () => {
  it('runs at most one task at a time within a scope (no overlap)', async () => {
    const scope = gitWorkingCopyLockScope('s1');
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const make = (id: number, hold: Promise<void>) =>
      withRepoLock(scope, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        await hold;
        active--;
        return id;
      });

    const g1 = deferred();
    const g2 = deferred();
    const p1 = make(1, g1.promise);
    const p2 = make(2, g2.promise);
    const p3 = make(3, Promise.resolve());

    await tick();
    // Only task 1 has entered; 2 and 3 are queued behind it.
    expect(order).toEqual([1]);
    expect(maxActive).toBe(1);

    g1.resolve();
    await tick();
    expect(order).toEqual([1, 2]); // 2 starts only after 1 releases

    g2.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]); // strict FIFO
    expect(maxActive).toBe(1); // never concurrent
  });

  it('preserves the return value of each task', async () => {
    const scope = gitWorkingCopyLockScope('s2');
    const a = withRepoLock(scope, async () => 'a');
    const b = withRepoLock(scope, async () => 42);
    expect(await a).toBe('a');
    expect(await b).toBe(42);
  });
});

describe('withRepoLock — independence across scopes', () => {
  it('does not block tasks in different scopes', async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred();

    const run = (scopeId: string) =>
      withRepoLock(gitWorkingCopyLockScope(scopeId), async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
      });

    const p1 = run('alpha');
    const p2 = run('beta');
    await tick();
    // Distinct working copies run concurrently.
    expect(maxActive).toBe(2);

    gate.resolve();
    await Promise.all([p1, p2]);
  });
});

describe('withRepoLock — failure handling', () => {
  it('releases the lock when a task throws, so the next waiter still runs', async () => {
    const scope = gitWorkingCopyLockScope('s3');
    const ran: string[] = [];

    const failing = withRepoLock(scope, async () => {
      ran.push('failing');
      throw new Error('boom');
    });
    const next = withRepoLock(scope, async () => {
      ran.push('next');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom'); // caller sees its own rejection
    expect(await next).toBe('ok'); // lane was not wedged
    expect(ran).toEqual(['failing', 'next']);
  });
});

describe('withRepoLock — lane cleanup', () => {
  it('drains the lane back to empty after the last task completes', async () => {
    const scope = gitWorkingCopyLockScope('s4');
    await withRepoLock(scope, async () => undefined);
    expect(activeRepoLockCount()).toBe(0);

    // A fresh acquisition after a drain creates a new lane and drains again.
    await Promise.all([
      withRepoLock(scope, async () => tick()),
      withRepoLock(scope, async () => tick()),
    ]);
    expect(activeRepoLockCount()).toBe(0);
  });

  it('keeps the lane alive while work is queued, even if an earlier task threw', async () => {
    const scope = gitWorkingCopyLockScope('s5');
    const hold = deferred();

    const first = withRepoLock(scope, async () => {
      await hold.promise;
      throw new Error('first failed');
    });
    const second = withRepoLock(scope, async () => 'second');

    await tick();
    expect(activeRepoLockCount()).toBe(1); // lane held while both are in flight

    hold.resolve();
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toBe('second');
    expect(activeRepoLockCount()).toBe(0);
  });
});

describe('withRepoLock — structured logs', () => {
  it('emits paired wait/acquired logs only on contention', async () => {
    const scope = gitWorkingCopyLockScope('s6');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hold = deferred();

    const first = withRepoLock(scope, async () => {
      await hold.promise;
    });
    const second = withRepoLock(scope, async () => undefined);

    await tick();
    // First task was uncontended → silent. Second queued behind it → one wait.
    const eventsOf = (calls: unknown[][]) => calls.map((c) => JSON.parse(c[0] as string).event);
    expect(eventsOf(log.mock.calls)).toEqual(['git_repo_lock_wait']);

    hold.resolve();
    await Promise.all([first, second]);

    expect(eventsOf(log.mock.calls)).toEqual(['git_repo_lock_wait', 'git_repo_lock_acquired']);
  });

  it('stays silent for an uncontended acquisition', async () => {
    const scope = gitWorkingCopyLockScope('s7');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withRepoLock(scope, async () => undefined);
    expect(log).not.toHaveBeenCalled();
  });
});
