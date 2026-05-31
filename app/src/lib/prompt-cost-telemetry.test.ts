import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_TOOL_TURN_IDLE_EVENT,
  GITHUB_TOOL_TURN_USED_EVENT,
  PROMPT_COST_EVENT,
  emitGithubToolTurnUsage,
  emitPromptCompositionCost,
  extractMarkedBlock,
  type PromptCompositionCost,
} from '@push/lib/prompt-cost-telemetry';

const OPEN = '[PROJECT INSTRUCTIONS]';
const CLOSE = '[/PROJECT INSTRUCTIONS]';

/** Parse the single JSON line a console.log spy captured. */
function loggedObject(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const arg = spy.mock.calls[0]?.[0];
  expect(typeof arg).toBe('string');
  return JSON.parse(arg as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractMarkedBlock', () => {
  it('returns the block including both markers', () => {
    const text = `prefix\n\n${OPEN}\nbe nice\n${CLOSE}\n\nsuffix`;
    const block = extractMarkedBlock(text, OPEN, CLOSE);
    expect(block).toBe(`${OPEN}\nbe nice\n${CLOSE}`);
    // Byte cost the caller measures is the full marked span, not just the body.
    expect(block?.length).toBe(`${OPEN}\nbe nice\n${CLOSE}`.length);
  });

  it('returns null when the block is absent', () => {
    expect(extractMarkedBlock('no markers here', OPEN, CLOSE)).toBeNull();
    expect(extractMarkedBlock('', OPEN, CLOSE)).toBeNull();
  });

  it('returns null when markers are mis-ordered (close before open)', () => {
    expect(extractMarkedBlock(`${CLOSE} ... ${OPEN}`, OPEN, CLOSE)).toBeNull();
  });
});

describe('emitPromptCompositionCost', () => {
  const cost: PromptCompositionCost = {
    systemPromptBytes: 12000,
    githubProtocolBytes: 18300,
    projectInstructionsBytes: 4096,
    systemPromptTokens: 3000,
    githubProtocolTokens: 4575,
    projectInstructionsTokens: 1024,
  };

  it('emits one structured line under the pinned event name with the full breakdown', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitPromptCompositionCost({ surface: 'web', scopeId: 'chat-1', round: 3, mode: 'repo' }, cost);
    expect(loggedObject(spy)).toEqual({
      level: 'info',
      event: PROMPT_COST_EVENT,
      surface: 'web',
      scopeId: 'chat-1',
      round: 3,
      mode: 'repo',
      ...cost,
    });
  });

  it('still emits (with zeros) when the always-on blocks are absent', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitPromptCompositionCost(
      { surface: 'cli', scopeId: 'session-2', round: 0, mode: 'cli' },
      {
        systemPromptBytes: 800,
        githubProtocolBytes: 0,
        projectInstructionsBytes: 0,
        systemPromptTokens: 200,
        githubProtocolTokens: 0,
        projectInstructionsTokens: 0,
      },
    );
    const obj = loggedObject(spy);
    expect(obj.event).toBe(PROMPT_COST_EVENT);
    expect(obj.githubProtocolBytes).toBe(0);
  });
});

describe('emitGithubToolTurnUsage', () => {
  it('emits the "used" event when the model called at least one GitHub tool', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitGithubToolTurnUsage(
      { surface: 'web', scopeId: 'chat-1', round: 2, mode: 'repo' },
      { githubCalls: 2, totalCalls: 3 },
    );
    expect(loggedObject(spy)).toEqual({
      level: 'info',
      event: GITHUB_TOOL_TURN_USED_EVENT,
      surface: 'web',
      scopeId: 'chat-1',
      round: 2,
      mode: 'repo',
      githubCalls: 2,
      totalCalls: 3,
    });
  });

  it('emits the symmetric "idle" event when no GitHub tool was called', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitGithubToolTurnUsage(
      { surface: 'cli', scopeId: 'session-1', round: 4, mode: 'cli' },
      { githubCalls: 0, totalCalls: 1 },
    );
    const obj = loggedObject(spy);
    expect(obj.event).toBe(GITHUB_TOOL_TURN_IDLE_EVENT);
    expect(obj.githubCalls).toBe(0);
    expect(obj.totalCalls).toBe(1);
  });

  it('keeps the used/idle event names distinct so counts can be summed per chat', () => {
    expect(GITHUB_TOOL_TURN_USED_EVENT).not.toBe(GITHUB_TOOL_TURN_IDLE_EVENT);
  });
});
