/**
 * useConnectedCliSessions.test — unit coverage for the non-React
 * connection controller (`createConnectedCliSessionsController`), the
 * riskiest logic in the Connected-section feature: generation guards
 * against superseded activations, the synchronous-open edge, and every
 * failure branch degrading to an empty (never stale) list. The hook
 * itself is thin effect glue, exercised at integration time per the
 * project's hook-testing convention.
 */
import { describe, expect, it, vi } from 'vitest';

import type { LocalDaemonBinding, SessionResponse } from '@/lib/local-daemon-binding';
import type { PairedRemoteRecord } from '@/lib/relay-storage';
import type { DaemonCliSession } from '@/types';

import { createConnectedCliSessionsController } from './useConnectedCliSessions';

const RECORD: PairedRemoteRecord = {
  id: 'relay-default',
  deploymentUrl: 'https://push.example.com',
  sessionId: 'pushd-testhost',
  token: 'pushd_da_test',
  pairedAt: 1_700_000_000_000,
};

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess_test_abcdef',
    updatedAt: 1_700_000_000_000,
    provider: 'openrouter',
    model: 'claude-3-5-sonnet',
    cwd: '/Users/dev/proj',
    sessionName: 'Review auth middleware',
    lastUserMessage: 'fix the regex',
    mode: 'tui',
    state: 'idle',
    activeRunId: null,
    ...overrides,
  };
}

function listResponse(rows: Record<string, unknown>[]): SessionResponse<{ sessions: unknown }> {
  return {
    v: 1,
    kind: 'response',
    requestId: 'req_test',
    type: 'list_sessions',
    ok: true,
    payload: { sessions: rows },
  } as unknown as SessionResponse<{ sessions: unknown }>;
}

interface FakeBindingSeams {
  binding: LocalDaemonBinding;
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeBinding(
  requestImpl: () => Promise<SessionResponse<unknown>> = () => Promise.resolve(listResponse([])),
): FakeBindingSeams {
  const request = vi.fn(requestImpl);
  const close = vi.fn();
  return {
    binding: {
      get status() {
        return { state: 'open' as const };
      },
      request,
      close,
    } as unknown as LocalDaemonBinding,
    request,
    close,
  };
}

/** Await until all currently-queued microtasks (and their children) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('createConnectedCliSessionsController', () => {
  it('emits an empty list when no pairing is stored', async () => {
    const onSessions = vi.fn();
    const createBinding = vi.fn();
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => null,
      createBinding,
      onSessions,
    });
    controller.activate();
    await flush();
    expect(onSessions).toHaveBeenCalledWith([]);
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('lists sessions once the binding opens (async open)', async () => {
    const onSessions = vi.fn();
    const fake = makeFakeBinding(() => Promise.resolve(listResponse([sessionRow()])));
    const captured: { handlers?: { onOpen: () => void; onDead: () => void } } = {};
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        captured.handlers = h;
        return fake.binding;
      },
      onSessions,
    });
    controller.activate();
    await flush();
    expect(onSessions).not.toHaveBeenCalled();
    captured.handlers?.onOpen();
    await flush();
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.request.mock.calls[0][0]).toMatchObject({
      type: 'list_sessions',
      payload: { excludeModes: ['headless'] },
    });
    const rows = onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('sess_test_abcdef');
  });

  it('survives a binding that fires onOpen synchronously during construction', async () => {
    // Pins the openedBeforeAssign latch: without it, a sync onOpen
    // dereferences the not-yet-assigned binding variable and throws.
    const onSessions = vi.fn();
    const fake = makeFakeBinding(() => Promise.resolve(listResponse([sessionRow()])));
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        h.onOpen(); // synchronous open, before createBinding returns
        return fake.binding;
      },
      onSessions,
    });
    controller.activate();
    await flush();
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[]).toHaveLength(1);
  });

  it('clears rows when the list request fails', async () => {
    const onSessions = vi.fn();
    const fake = makeFakeBinding(() => Promise.reject(new Error('timeout')));
    const captured: { handlers?: { onOpen: () => void; onDead: () => void } } = {};
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        captured.handlers = h;
        return fake.binding;
      },
      onSessions,
    });
    controller.activate();
    await flush();
    captured.handlers?.onOpen();
    await flush();
    expect(onSessions).toHaveBeenCalledWith([]);
  });

  it('clears rows when the connection dies (onDead)', async () => {
    const onSessions = vi.fn();
    const fake = makeFakeBinding(() => Promise.resolve(listResponse([sessionRow()])));
    const captured: { handlers?: { onOpen: () => void; onDead: () => void } } = {};
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        captured.handlers = h;
        return fake.binding;
      },
      onSessions,
    });
    controller.activate();
    await flush();
    captured.handlers?.onOpen();
    await flush();
    expect(onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[]).toHaveLength(1);
    captured.handlers?.onDead();
    expect(onSessions.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('clears rows when dialing throws', async () => {
    const onSessions = vi.fn();
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: () => {
        throw new Error('loopback refused');
      },
      onSessions,
    });
    controller.activate();
    await flush();
    expect(onSessions).toHaveBeenCalledWith([]);
  });

  it('deactivate closes the binding and clears rows (Connected never outlives the connection)', async () => {
    const onSessions = vi.fn();
    const fake = makeFakeBinding(() => Promise.resolve(listResponse([sessionRow()])));
    const captured: { handlers?: { onOpen: () => void; onDead: () => void } } = {};
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        captured.handlers = h;
        return fake.binding;
      },
      onSessions,
    });
    controller.activate();
    await flush();
    captured.handlers?.onOpen();
    await flush();
    expect(onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[]).toHaveLength(1);
    controller.deactivate();
    expect(fake.close).toHaveBeenCalled();
    expect(onSessions.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('a superseded activation cannot emit rows after deactivate', async () => {
    // Deferred pairing load: deactivate() fires while the load is still
    // in flight; when it resolves, the stale generation must not dial
    // or emit anything beyond deactivate's own clear.
    const onSessions = vi.fn();
    const createBinding = vi.fn();
    let resolveLoad: (record: PairedRemoteRecord | null) => void = () => {};
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: () =>
        new Promise<PairedRemoteRecord | null>((resolve) => {
          resolveLoad = resolve;
        }),
      createBinding,
      onSessions,
    });
    controller.activate();
    controller.deactivate();
    const callsAfterDeactivate = onSessions.mock.calls.length;
    resolveLoad(RECORD);
    await flush();
    expect(createBinding).not.toHaveBeenCalled();
    expect(onSessions.mock.calls.length).toBe(callsAfterDeactivate);
  });

  it('a late list response from a superseded activation is dropped', async () => {
    // First activation opens and its list request hangs; a second
    // activation supersedes it. When the first response finally lands,
    // it must be discarded — only the second activation's rows win.
    const onSessions = vi.fn();
    let resolveFirstList: (res: SessionResponse<unknown>) => void = () => {};
    const first = makeFakeBinding(
      () =>
        new Promise<SessionResponse<unknown>>((resolve) => {
          resolveFirstList = resolve;
        }),
    );
    const second = makeFakeBinding(() =>
      Promise.resolve(listResponse([sessionRow({ sessionId: 'sess_second_activation' })])),
    );
    const bindings = [first, second];
    const handlerSets: { onOpen: () => void; onDead: () => void }[] = [];
    const controller = createConnectedCliSessionsController({
      loadPairedRemote: async () => RECORD,
      createBinding: (_record, h) => {
        handlerSets.push(h);
        const fake = bindings.shift();
        if (!fake) throw new Error('unexpected extra dial');
        return fake.binding;
      },
      onSessions,
    });

    controller.activate();
    await flush();
    handlerSets[0].onOpen(); // first list request now pending
    await flush();

    controller.activate(); // supersedes; closes the first binding
    await flush();
    expect(first.close).toHaveBeenCalled();
    handlerSets[1].onOpen();
    await flush();
    expect((onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[])[0]?.sessionId).toBe(
      'sess_second_activation',
    );

    resolveFirstList(listResponse([sessionRow({ sessionId: 'sess_stale_first' })]));
    await flush();
    const finalRows = onSessions.mock.calls.at(-1)?.[0] as DaemonCliSession[];
    expect(finalRows[0]?.sessionId).toBe('sess_second_activation');
  });
});
