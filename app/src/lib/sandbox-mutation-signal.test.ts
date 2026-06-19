import { describe, it, expect, vi, afterEach } from 'vitest';
import { onWorkspaceMutation, notifyWorkspaceMutation } from './sandbox-mutation-signal';

describe('onWorkspaceMutation / notifyWorkspaceMutation', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
  const sub = (fn: (id: string) => void) => {
    const off = onWorkspaceMutation(fn);
    cleanups.push(off);
    return off;
  };

  it('notifies subscribers with the sandbox id', () => {
    const seen: string[] = [];
    sub((id) => seen.push(id));
    notifyWorkspaceMutation('sb-1');
    notifyWorkspaceMutation('sb-2');
    expect(seen).toEqual(['sb-1', 'sb-2']);
  });

  it('stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = sub(fn);
    notifyWorkspaceMutation('sb-1');
    off();
    notifyWorkspaceMutation('sb-1');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener never breaks dispatch or other listeners', () => {
    sub(() => {
      throw new Error('observer blew up');
    });
    const ok = vi.fn();
    sub(ok);
    expect(() => notifyWorkspaceMutation('sb-1')).not.toThrow();
    expect(ok).toHaveBeenCalledWith('sb-1');
  });
});
