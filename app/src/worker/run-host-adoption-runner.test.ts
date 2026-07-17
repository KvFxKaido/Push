/**
 * Adopted-run loop runner — provisioning + loop-lifecycle tests.
 *
 * The coder kernel is mocked at the `@push/lib/coder-agent` seam (the kernel
 * itself is proven by its own lib tests and the CoderJob path); these tests
 * cover the runner's contract with the host: out-of-band credential
 * provisioning, per-round checkpoint persistence + watchdog re-arm, the
 * ownership (reclaim) check, the supervised pause bookkeeping, and the
 * bounded failure→retry path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoderAgentOptions } from '@push/lib/coder-agent';

const mocks = vi.hoisted(() => ({
  runCoderAgent: vi.fn(),
}));

vi.mock('@push/lib/coder-agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCoderAgent: mocks.runCoderAgent,
}));

// The executor adapter pulls in the CF sandbox handler, whose
// `@cloudflare/containers` dependency doesn't resolve under vitest — and the
// kernel is mocked anyway, so the handler is never invoked here. Same seam
// the coder-job-adapters tests mock.
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('./worker-cf-sandbox', () => ({ handleCloudflareSandbox: vi.fn() }));

import { RUN_HOST_MAX_ADOPTION_RELAUNCHES, type RunHostRecord } from '@push/lib/run-host-adoption';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';
import {
  provisionAdoption,
  runAdoptedLoop,
  type AdoptionHostHooks,
} from './run-host-adoption-runner';
import type { Env } from './worker-middleware';

const SCOPE = { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' };

function makeRecord(overrides: Partial<RunHostRecord> = {}): RunHostRecord {
  return {
    v: 1,
    runId: 'run-1',
    scope: SCOPE,
    mode: 'supervised',
    state: 'adopted',
    registeredAt: 1,
    lastHeartbeatAt: 1,
    hasCheckpoint: true,
    midFlight: true,
    round: 4,
    origin: 'https://push.test',
    adoptedAt: Date.now(),
    adoptionId: 'adoption-1',
    adoptionRelaunches: 0,
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<RunCheckpointV1> = {}): RunCheckpointV1 {
  return {
    v: 1,
    chatId: SCOPE.chatId,
    repoFullName: SCOPE.repoFullName,
    branch: SCOPE.branch,
    runId: 'run-1',
    round: 4,
    phase: 'executing_tools',
    savedAt: 1781000000000,
    reason: 'turn',
    messages: [
      { role: 'user', content: 'Fix the bug in foo.ts' },
      { role: 'assistant', content: 'On it.' },
    ],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'Fix the bug in foo.ts',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    sandboxSessionId: 'sb-1',
    ...overrides,
  } as RunCheckpointV1;
}

function makeEnv(
  tokens: Record<string, { token: string }> = { 'token:sb-1': { token: 'tok' } },
): Env {
  return {
    SANDBOX_TOKENS: {
      get: async (key: string) => tokens[key] ?? null,
    },
  } as unknown as Env;
}

interface HostState {
  record: RunHostRecord | null;
  checkpoints: RunCheckpointV1[];
  alarmAt: number | null;
  hooks: AdoptionHostHooks;
}

function makeHostState(record: RunHostRecord): HostState {
  const state: HostState = {
    record,
    checkpoints: [],
    alarmAt: null,
    hooks: {
      loadRecord: async () => (state.record ? { ...state.record } : null),
      saveRecord: async (r) => {
        state.record = { ...r };
      },
      saveCheckpoint: async (cp) => {
        state.checkpoints.push(cp);
      },
      armAlarm: async (at) => {
        state.alarmAt = at;
      },
      clearAlarm: async () => {
        state.alarmAt = null;
      },
    },
  };
  return state;
}

function loopArgs(state: HostState, checkpoint = makeCheckpoint()) {
  return {
    env: makeEnv(),
    record: state.record!,
    checkpoint,
    origin: 'https://push.test',
    sandboxId: 'sb-1',
    ownerToken: 'tok',
    abort: new AbortController(),
    hooks: state.hooks,
  };
}

type KernelCallbacks = {
  signal?: AbortSignal;
  onCheckpoint?: (state: {
    round: number;
    messages: Array<{
      id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      timestamp: number;
    }>;
    workingMemory: Record<string, unknown>;
    cards: unknown[];
  }) => Promise<void>;
};

beforeEach(() => {
  mocks.runCoderAgent.mockReset();
});

// ---------------------------------------------------------------------------
// provisionAdoption
// ---------------------------------------------------------------------------

describe('provisionAdoption', () => {
  it('resolves the owner token out-of-band from the sandbox-token KV', async () => {
    const result = await provisionAdoption(makeEnv(), makeRecord(), makeCheckpoint());
    expect(result).toEqual({
      ok: true,
      origin: 'https://push.test',
      sandboxId: 'sb-1',
      ownerToken: 'tok',
    });
  });

  it('fails closed on each missing precondition with a stable reason', async () => {
    expect(
      await provisionAdoption(makeEnv(), makeRecord({ origin: undefined }), makeCheckpoint()),
    ).toEqual({ ok: false, reason: 'no_origin' });
    expect(
      await provisionAdoption(
        makeEnv(),
        makeRecord(),
        makeCheckpoint({ sandboxSessionId: undefined }),
      ),
    ).toEqual({ ok: false, reason: 'no_sandbox_session' });
    expect(await provisionAdoption(makeEnv({}), makeRecord(), makeCheckpoint())).toEqual({
      ok: false,
      reason: 'no_sandbox_credentials',
    });
    expect(
      await provisionAdoption(makeEnv(), makeRecord(), makeCheckpoint({ provider: 'demo' })),
    ).toEqual({ ok: false, reason: 'unsupported_provider' });
  });
});

// ---------------------------------------------------------------------------
// runAdoptedLoop lifecycle
// ---------------------------------------------------------------------------

const kernelMessages = [
  { id: 'm0', role: 'user' as const, content: 'task', timestamp: 1 },
  { id: 'm1', role: 'assistant' as const, content: 'progress', timestamp: 2 },
];

describe('runAdoptedLoop', () => {
  it('persists per-round checkpoints, re-arms the watchdog, and ends the run on completion', async () => {
    const state = makeHostState(makeRecord());
    mocks.runCoderAgent.mockImplementation(
      async (_options: unknown, callbacks: KernelCallbacks) => {
        await callbacks.onCheckpoint!({
          round: 6,
          messages: kernelMessages,
          workingMemory: { plan: 'p' },
          cards: [],
        });
        return { summary: 'All done.', cards: [], rounds: 7, checkpoints: 1 };
      },
    );

    await runAdoptedLoop(loopArgs(state));

    // Per-round persistence happened and re-armed the watchdog before the
    // terminal transition cleared it.
    expect(state.checkpoints.length).toBe(2);
    expect(state.checkpoints[0].round).toBe(6);
    expect(state.checkpoints[0].runId).toBe('run-1');
    // The terminal checkpoint appends the kernel's summary for attach/reclaim.
    const final = state.checkpoints[1];
    expect(final.messages[final.messages.length - 1].content).toBe('All done.');
    expect(state.record?.state).toBe('ended');
    expect(state.record?.midFlight).toBe(false);
    expect(state.record?.round).toBe(6);
    expect(state.alarmAt).toBeNull();
  });

  it('resumes the adopted run as the lead persona (its own checkpointed turn)', async () => {
    const state = makeHostState(makeRecord());
    mocks.runCoderAgent.mockResolvedValue({
      summary: 'done',
      cards: [],
      rounds: 1,
      checkpoints: 0,
    });

    await runAdoptedLoop(loopArgs(state));

    expect(mocks.runCoderAgent).toHaveBeenCalledWith(
      // 'sandbox' scope: the adoption surface has no GitHub/ask/artifact tools,
      // so lead guidance must not steer toward them.
      expect.objectContaining({ persona: 'lead', leadToolScope: 'sandbox' }),
      expect.anything(),
    );
  });

  it('keeps completion policy conversational when adopting a conversational lead turn', async () => {
    const state = makeHostState(makeRecord());
    mocks.runCoderAgent.mockImplementation(async (options: CoderAgentOptions<never>) => {
      expect(await options.evaluateAfterModel('Nothing changed.', 5)).toBeNull();
      return { summary: 'Nothing changed.', cards: [], rounds: 1, checkpoints: 0 };
    });

    await runAdoptedLoop(loopArgs(state, makeCheckpoint({ userGoal: 'What changed?' })));

    expect(state.record?.state).toBe('ended');
  });

  it('stops without writing when ownership was lost (reclaim)', async () => {
    const state = makeHostState(makeRecord());
    const args = loopArgs(state);
    // Another adoption (or a reclaim) took the record before our first
    // checkpoint landed.
    state.record = makeRecord({ adoptionId: 'someone-else' });

    mocks.runCoderAgent.mockImplementation(
      async (_options: unknown, callbacks: KernelCallbacks) => {
        await callbacks.onCheckpoint!({
          round: 6,
          messages: kernelMessages,
          workingMemory: {},
          cards: [],
        });
        if (callbacks.signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return { summary: 'x', cards: [], rounds: 1, checkpoints: 0 };
      },
    );

    await runAdoptedLoop(args);

    expect(args.abort.signal.aborted).toBe(true);
    expect(state.checkpoints).toEqual([]);
    expect(state.record?.adoptionId).toBe('someone-else');
    expect(state.record?.state).toBe('adopted');
  });

  it('supervised pause: persists the pending approval + transcript, clears the watchdog, stops', async () => {
    const state = makeHostState(makeRecord());
    const args = loopArgs(state);

    mocks.runCoderAgent.mockImplementation(
      async (
        options: {
          toolExec: (
            call: { source: string; call: { tool: string; args: Record<string, unknown> } },
            ctx: { round: number },
          ) => Promise<{ resultText: string; policyPost?: { kind: string } }>;
        },
        callbacks: KernelCallbacks,
      ) => {
        const gated = await options.toolExec(
          { source: 'sandbox', call: { tool: 'sandbox_push', args: {} } },
          { round: 5 },
        );
        expect(gated.policyPost?.kind).toBe('halt');
        await callbacks.onCheckpoint!({
          round: 6,
          messages: kernelMessages,
          workingMemory: {},
          cards: [],
        });
        if (callbacks.signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return { summary: 'x', cards: [], rounds: 1, checkpoints: 0 };
      },
    );

    await runAdoptedLoop(args);

    expect(args.abort.signal.aborted).toBe(true);
    expect(state.record?.state).toBe('adopted');
    expect(state.record?.pausedForApproval?.kind).toBe('remote_side_effect');
    expect(state.record?.pausedForApproval?.approvalId).toBe('adopt-sandbox_push-r5');
    // The paused transcript (with the gate's note) is durable, and the
    // pending approval rides on the checkpoint too.
    expect(state.checkpoints.length).toBe(1);
    expect(state.checkpoints[0].pendingApproval?.approvalId).toBe('adopt-sandbox_push-r5');
    // No watchdog — nothing to relaunch while paused.
    expect(state.alarmAt).toBeNull();
  });

  it('failure parks the run adoptable with a bounded retry alarm', async () => {
    const state = makeHostState(makeRecord());
    mocks.runCoderAgent.mockRejectedValue(new Error('provider exploded'));

    await runAdoptedLoop(loopArgs(state));

    expect(state.record?.state).toBe('adoptable');
    expect(state.record?.adoptionRelaunches).toBe(1);
    expect(state.record?.lastError).toBe('provider exploded');
    expect(state.alarmAt).not.toBeNull();
  });

  it('failure grants the full relaunch budget: a count reaching the cap still retries', async () => {
    // Increment-before-launch means the count includes the upcoming retry, so
    // count === cap is the LAST permitted relaunch — the same budget the
    // orphan watchdog grants. (`<` here was an off-by-one that gave failures
    // one fewer relaunch than evictions.)
    const state = makeHostState(
      makeRecord({ adoptionRelaunches: RUN_HOST_MAX_ADOPTION_RELAUNCHES - 1 }),
    );
    mocks.runCoderAgent.mockRejectedValue(new Error('still broken'));

    await runAdoptedLoop(loopArgs(state));

    expect(state.record?.state).toBe('adoptable');
    expect(state.record?.adoptionRelaunches).toBe(RUN_HOST_MAX_ADOPTION_RELAUNCHES);
    expect(state.alarmAt).not.toBeNull();
  });

  it('failure past the relaunch cap parks adoptable with NO retry alarm', async () => {
    const state = makeHostState(
      makeRecord({ adoptionRelaunches: RUN_HOST_MAX_ADOPTION_RELAUNCHES }),
    );
    state.alarmAt = 123;
    mocks.runCoderAgent.mockRejectedValue(new Error('still broken'));

    await runAdoptedLoop(loopArgs(state));

    expect(state.record?.state).toBe('adoptable');
    expect(state.record?.adoptionRelaunches).toBe(RUN_HOST_MAX_ADOPTION_RELAUNCHES + 1);
    expect(state.alarmAt).toBeNull();
  });

  it('an abort with no pause is a clean reclaim (no record writes)', async () => {
    const state = makeHostState(makeRecord());
    const args = loopArgs(state);
    mocks.runCoderAgent.mockImplementation(
      async (_options: unknown, callbacks: KernelCallbacks) => {
        args.abort.abort();
        if (callbacks.signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return { summary: 'x', cards: [], rounds: 1, checkpoints: 0 };
      },
    );

    await runAdoptedLoop(args);

    expect(state.record?.state).toBe('adopted');
    expect(state.checkpoints).toEqual([]);
  });
});
