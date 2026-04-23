import { describe, expect, it } from 'vitest';
import {
  selectTimeoutMessage,
  type StreamProviderConfig,
  type TimeoutAbortReason,
  type TimeoutDurations,
} from './orchestrator-streaming';

function makeMessages(
  overrides: Partial<StreamProviderConfig['errorMessages']> = {},
): StreamProviderConfig['errorMessages'] {
  return {
    keyMissing: 'missing',
    connect: (s) => `connect ${s}s`,
    idle: (s) => `idle ${s}s`,
    progress: (s) => `progress ${s}s`,
    stall: (s) => `stall ${s}s`,
    total: (s) => `total ${s}s`,
    network: 'network',
    ...overrides,
  };
}

const DEFAULT_TIMEOUTS: TimeoutDurations = {
  connectTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  progressTimeoutMs: 45_000,
  stallTimeoutMs: 90_000,
  totalTimeoutMs: 180_000,
};

describe('selectTimeoutMessage', () => {
  it('returns the connect message for connect aborts', () => {
    expect(selectTimeoutMessage('connect', makeMessages(), DEFAULT_TIMEOUTS)).toBe('connect 30s');
  });

  it('returns the idle message for idle aborts', () => {
    expect(selectTimeoutMessage('idle', makeMessages(), DEFAULT_TIMEOUTS)).toBe('idle 60s');
  });

  it('returns the progress message when the progress path is armed', () => {
    expect(selectTimeoutMessage('progress', makeMessages(), DEFAULT_TIMEOUTS)).toBe('progress 45s');
  });

  it('falls back from progress to stall when progress message is missing', () => {
    const msgs = makeMessages({ progress: undefined });
    expect(selectTimeoutMessage('progress', msgs, DEFAULT_TIMEOUTS)).toBe('stall 90s');
  });

  it('falls back from progress to idle when both progress and stall messages are missing', () => {
    const msgs = makeMessages({ progress: undefined, stall: undefined });
    expect(selectTimeoutMessage('progress', msgs, DEFAULT_TIMEOUTS)).toBe('idle 60s');
  });

  it('uses idleTimeoutMs for the progress seconds when progressTimeoutMs is not configured', () => {
    // Provider left progressTimeoutMs undefined but the abort reason still
    // fires (e.g., raced with a timer that was armed via the stall path).
    // Falling back to idleTimeoutMs is the safest rendering.
    const msgs = makeMessages({ progress: (s) => `progress ${s}s` });
    const noProgressTimeout: TimeoutDurations = {
      ...DEFAULT_TIMEOUTS,
      progressTimeoutMs: undefined,
    };
    expect(selectTimeoutMessage('progress', msgs, noProgressTimeout)).toBe('progress 60s');
  });

  it('returns the stall message for stall aborts', () => {
    expect(selectTimeoutMessage('stall', makeMessages(), DEFAULT_TIMEOUTS)).toBe('stall 90s');
  });

  it('falls back from stall to idle when stall message is missing', () => {
    const msgs = makeMessages({ stall: undefined });
    expect(selectTimeoutMessage('stall', msgs, DEFAULT_TIMEOUTS)).toBe('idle 60s');
  });

  it('returns the total message for total aborts', () => {
    expect(selectTimeoutMessage('total', makeMessages(), DEFAULT_TIMEOUTS)).toBe('total 180s');
  });

  it('falls back from total to idle when total message is missing', () => {
    const msgs = makeMessages({ total: undefined });
    expect(selectTimeoutMessage('total', msgs, DEFAULT_TIMEOUTS)).toBe('idle 60s');
  });

  it('rounds millisecond durations to whole seconds', () => {
    const msgs = makeMessages();
    const timeouts: TimeoutDurations = {
      ...DEFAULT_TIMEOUTS,
      connectTimeoutMs: 29_499,
      idleTimeoutMs: 59_501,
    };
    expect(selectTimeoutMessage('connect', msgs, timeouts)).toBe('connect 29s');
    expect(selectTimeoutMessage('idle', msgs, timeouts)).toBe('idle 60s');
  });

  it('covers every non-idle abort reason without throwing when only idle is defined', () => {
    const msgs = makeMessages({
      progress: undefined,
      stall: undefined,
      total: undefined,
    });
    const reasons: TimeoutAbortReason[] = ['progress', 'stall', 'total'];
    for (const reason of reasons) {
      expect(selectTimeoutMessage(reason, msgs, DEFAULT_TIMEOUTS)).toBe('idle 60s');
    }
  });
});
