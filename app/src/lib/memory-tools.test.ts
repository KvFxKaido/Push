import { describe, it, expect } from 'vitest';
import { detectMemoryToolCall } from './memory-tools';

describe('detectMemoryToolCall', () => {
  it('detects a memory_grep call with a pattern', () => {
    const call = detectMemoryToolCall(
      '```json\n{"tool":"memory_grep","args":{"pattern":"auth refresh"}}\n```',
    );
    expect(call).toEqual({ tool: 'memory_grep', args: { pattern: 'auth refresh' } });
  });

  it('carries optional kinds and limit on memory_grep', () => {
    const call = detectMemoryToolCall(
      '{"tool":"memory_grep","args":{"pattern":"x","kinds":["decision"],"limit":5}}',
    );
    expect(call).toEqual({
      tool: 'memory_grep',
      args: { pattern: 'x', kinds: ['decision'], limit: 5 },
    });
  });

  it('detects a memory_expand call with ids', () => {
    const call = detectMemoryToolCall('{"tool":"memory_expand","args":{"ids":["mem_a","mem_b"]}}');
    expect(call).toEqual({ tool: 'memory_expand', args: { ids: ['mem_a', 'mem_b'] } });
  });

  it('rejects memory_grep without a string pattern', () => {
    expect(detectMemoryToolCall('{"tool":"memory_grep","args":{}}')).toBeNull();
    expect(detectMemoryToolCall('{"tool":"memory_grep","args":{"pattern":123}}')).toBeNull();
  });

  it('rejects memory_expand without ids', () => {
    expect(detectMemoryToolCall('{"tool":"memory_expand","args":{"ids":[]}}')).toBeNull();
    expect(detectMemoryToolCall('{"tool":"memory_expand","args":{}}')).toBeNull();
  });

  it('returns null for non-memory tool calls', () => {
    expect(detectMemoryToolCall('{"tool":"web","args":{"query":"x"}}')).toBeNull();
    expect(detectMemoryToolCall('no tool call here')).toBeNull();
  });
});
