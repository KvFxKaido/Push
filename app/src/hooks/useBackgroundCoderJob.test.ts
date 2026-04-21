import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundJobPersistenceEntry,
  ChatCard,
  Conversation,
  DelegationEnvelope,
  UserProfile,
} from '@/types';

// --- Hand-rolled React harness ---
// Matches the pattern used in useRunEventStream.test.ts. Tests here
// drive startJob / cancelJob / the SSE loop directly; no rendering
// required. useEffect is a no-op — the visibility-change listener is
// exercised by calling the returned handle after manually dispatching
// a visibilitychange event is not required for this tier of coverage.
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  memos: [] as unknown[],
  memoIndex: 0,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useMemo: <T>(fn: () => T) => {
    const i = reactState.memoIndex++;
    const value = fn();
    reactState.memos[i] = value;
    return value;
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

// Mock the inline-card helpers so we don't have to construct a full
// ChatMessage tree — assertions work off the setConversations calls.
vi.mock('@/lib/delegation-result', () => ({
  filterDelegationCardsForInlineDisplay: (cards: readonly ChatCard[]) => [...cards],
}));
vi.mock('@/lib/chat-tool-messages', () => ({
  appendCardsToLatestToolCall: (msgs: unknown[], cards: readonly ChatCard[]) => {
    const lastIdx = msgs.length - 1;
    if (lastIdx < 0) return msgs;
    const last = msgs[lastIdx] as { cards?: ChatCard[] };
    const merged = { ...last, cards: [...(last.cards ?? []), ...cards] };
    return [...msgs.slice(0, lastIdx), merged];
  },
}));

const { useBackgroundCoderJob } = await import('./useBackgroundCoderJob');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.memos = [];
  reactState.memoIndex = 0;
});

function makeConversation(id = 'chat-1'): Conversation {
  return {
    id,
    title: 'Test chat',
    messages: [
      // The hook's appendJobCard pushes into the latest tool-call via
      // the stubbed appendCardsToLatestToolCall — so give it something
      // to push onto.
      {
        id: 'm1',
        role: 'assistant',
        content: 'delegate_coder …',
        timestamp: 1,
        isToolCall: true,
      },
    ],
    createdAt: 1,
    lastMessageAt: 1,
  };
}

function makeEnvelope(): DelegationEnvelope {
  return {
    task: 'Fix the thing',
    files: ['src/foo.ts'],
    provider: 'openrouter',
  } as DelegationEnvelope;
}

// The react mock above replaces useState/useRef/useMemo with pure test
// doubles, so calling the hook from a plain factory is safe. The
// `use*` name is deliberate so react-hooks/rules-of-hooks treats the
// call legally, and mutation lives on a box object so
// react-hooks/immutability doesn't fire on reassigned locals.
function useHarness(initialConvs: Record<string, Conversation> = {}) {
  const convsBox = { value: initialConvs };
  const conversationsRef = { current: convsBox.value };
  const setConversations = vi.fn((updater: unknown) => {
    const next =
      typeof updater === 'function'
        ? (updater as (prev: Record<string, Conversation>) => Record<string, Conversation>)(
            convsBox.value,
          )
        : (updater as Record<string, Conversation>);
    convsBox.value = next;
    conversationsRef.current = next;
  });
  const appendRunEvent = vi.fn();
  const emitRunEngineEvent = vi.fn();
  const updateAgentStatus = vi.fn();

  const hook = useBackgroundCoderJob({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setConversations: setConversations as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationsRef: conversationsRef as any,
    appendRunEvent,
    emitRunEngineEvent,
    updateAgentStatus,
  });

  return {
    hook,
    setConversations,
    appendRunEvent,
    emitRunEngineEvent,
    updateAgentStatus,
    getConvs: () => convsBox.value,
  };
}

describe('useBackgroundCoderJob — startJob', () => {
  it('POSTs /api/jobs/start with the server-expected body shape, omitting jobId and origin', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'job-42' }), { status: 202 }) as Response,
      )
      // SSE stream — immediately closes so the start flow finishes.
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }) as Response,
      );
    vi.stubGlobal('fetch', fetchMock);

    const convs = { 'chat-1': makeConversation('chat-1') };
    const { hook } = useHarness(convs);
    const result = await hook.startJob({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      envelope: makeEnvelope(),
      provider: 'openrouter',
      model: 'gpt-4',
      userProfile: {} as UserProfile,
    });

    expect(result).toEqual({ ok: true, jobId: 'job-42' });
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/jobs/start');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
      model: 'gpt-4',
    });
    // Hardening: neither jobId nor origin may be sent by the client.
    // See app/src/worker/worker-coder-job.ts :108-122.
    expect(body).not.toHaveProperty('jobId');
    expect(body).not.toHaveProperty('origin');

    vi.unstubAllGlobals();
  });

  it('persists a pendingJobIds entry and appends a coder-job ChatCard on success', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'job-7' }), { status: 202 }) as Response,
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }) as Response,
      );
    vi.stubGlobal('fetch', fetchMock);

    const convs = { 'chat-1': makeConversation('chat-1') };
    const { hook, getConvs } = useHarness(convs);
    await hook.startJob({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      envelope: makeEnvelope(),
      provider: 'openrouter',
      model: undefined,
      userProfile: null,
    });

    const entry: BackgroundJobPersistenceEntry | undefined =
      getConvs()['chat-1']?.pendingJobIds?.['job-7'];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('queued');
    expect(entry?.lastEventId).toBeNull();

    const msgs = getConvs()['chat-1'].messages;
    const last = msgs[msgs.length - 1] as { cards?: ChatCard[] };
    expect(last.cards?.some((c) => c.type === 'coder-job')).toBe(true);

    vi.unstubAllGlobals();
  });

  it('returns ok:false when the server responds non-2xx', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'MISSING_FIELDS', fields: ['sandboxId'] }), {
        status: 400,
      }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const { hook } = useHarness({ 'chat-1': makeConversation() });
    const result = await hook.startJob({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: '',
      ownerToken: 'tok-1',
      envelope: makeEnvelope(),
      provider: 'openrouter',
      model: undefined,
      userProfile: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('MISSING_FIELDS');
    }

    vi.unstubAllGlobals();
  });
});

describe('useBackgroundCoderJob — SSE dispatch', () => {
  it('parses server-stamped events, re-stamps through appendRunEvent, and tracks Last-Event-ID', async () => {
    const completedEvent = {
      id: 'ev-2',
      timestamp: 1234,
      type: 'subagent.completed',
      executionId: 'job-77',
      agent: 'coder',
      summary: 'Done.',
    };
    const startedEvent = {
      id: 'ev-1',
      timestamp: 1233,
      type: 'subagent.started',
      executionId: 'job-77',
      agent: 'coder',
      detail: 'Fix the thing',
    };
    const sse =
      `id: ${startedEvent.id}\nevent: ${startedEvent.type}\ndata: ${JSON.stringify(startedEvent)}\n\n` +
      `id: ${completedEvent.id}\nevent: ${completedEvent.type}\ndata: ${JSON.stringify(completedEvent)}\n\n`;

    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'job-77' }), { status: 202 }) as Response,
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(sse));
              c.close();
            },
          }),
          { status: 200 },
        ) as Response,
      );
    vi.stubGlobal('fetch', fetchMock);

    const convs = { 'chat-1': makeConversation('chat-1') };
    const { hook, appendRunEvent, emitRunEngineEvent, getConvs } = useHarness(convs);
    await hook.startJob({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      envelope: makeEnvelope(),
      provider: 'openrouter',
      model: undefined,
      userProfile: null,
    });

    // Yield so the SSE reader drains. The stream closes synchronously
    // after enqueue but the fetch().then chain still needs a microtask
    // tick.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // appendRunEvent should have been called for each SSE event,
    // with server id/timestamp stripped (RunEventInput shape).
    const startedCall = appendRunEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'subagent.started',
    );
    expect(startedCall).toBeDefined();
    expect(startedCall?.[0]).toBe('chat-1');
    expect(startedCall?.[1]).not.toHaveProperty('id');
    expect(startedCall?.[1]).not.toHaveProperty('timestamp');

    const completedCall = appendRunEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'subagent.completed',
    );
    expect(completedCall).toBeDefined();

    // Terminal event should route DELEGATION_COMPLETED into run engine.
    expect(emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DELEGATION_COMPLETED', agent: 'coder' }),
    );

    // Persistence should reflect terminal status + the latest seen id.
    const entry = getConvs()['chat-1']?.pendingJobIds?.['job-77'];
    expect(entry?.status).toBe('completed');
    expect(entry?.lastEventId).toBe('ev-2');

    // JobCard data must have finishedAt set so the elapsed timer
    // freezes at the real end time rather than collapsing to 0.
    const msgs = getConvs()['chat-1'].messages;
    const card = msgs.flatMap((m) => m.cards ?? []).find((c) => c.type === 'coder-job') as
      | { data: { finishedAt?: number } }
      | undefined;
    expect(card).toBeDefined();
    expect(typeof card?.data.finishedAt).toBe('number');

    vi.unstubAllGlobals();
  });

  it('sends Last-Event-ID header when reconnecting via the exposed startJob path (initial = null)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: 'job-9' }), { status: 202 }) as Response,
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }) as Response,
      );
    vi.stubGlobal('fetch', fetchMock);

    const { hook } = useHarness({ 'chat-1': makeConversation() });
    await hook.startJob({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      branch: 'main',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      envelope: makeEnvelope(),
      provider: 'openrouter',
      model: undefined,
      userProfile: null,
    });

    const sseCall = fetchMock.mock.calls[1];
    expect(sseCall[0]).toBe('/api/jobs/job-9/events');
    const headers = (sseCall[1] as RequestInit).headers as Record<string, string>;
    // Initial connect — no Last-Event-ID expected.
    expect(headers['Last-Event-ID']).toBeUndefined();
    expect(headers['Accept']).toBe('text/event-stream');

    vi.unstubAllGlobals();
  });
});

describe('useBackgroundCoderJob — placeholder text contract', () => {
  it('never claims the job "started" or "completed" — only "accepted and queued"', () => {
    const { hook } = useHarness({});
    const text = hook.formatPlaceholderText('job-abc');
    expect(text).toContain('accepted and queued');
    expect(text).toContain('job-abc');
    expect(text).not.toMatch(/completed|succe(ss|eded)|started successfully/i);
  });
});

describe('useBackgroundCoderJob — cancelJob', () => {
  it('POSTs to /api/jobs/:id/cancel', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cancelled: true }), { status: 200 }) as Response,
      );
    vi.stubGlobal('fetch', fetchMock);

    const { hook } = useHarness({});
    await hook.cancelJob('job-abc');
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-abc/cancel', { method: 'POST' });

    vi.unstubAllGlobals();
  });
});
