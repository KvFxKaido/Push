import { describe, it, expect } from 'vitest';
import {
  CORRELATION_FIELD_NAMES,
  CORRELATION_SPAN_ATTRIBUTE_KEYS,
  EMPTY_CORRELATION_CONTEXT,
  correlationToSpanAttributes,
  extendCorrelation,
  hasAnyCorrelation,
  hasRunCorrelation,
  type CorrelationContext,
} from './correlation-context';

describe('CorrelationContext', () => {
  describe('EMPTY_CORRELATION_CONTEXT', () => {
    it('is frozen so callers cannot mutate the shared instance', () => {
      expect(Object.isFrozen(EMPTY_CORRELATION_CONTEXT)).toBe(true);
    });

    it('has no correlation fields set', () => {
      expect(hasAnyCorrelation(EMPTY_CORRELATION_CONTEXT)).toBe(false);
    });
  });

  describe('extendCorrelation', () => {
    it('merges patch fields into base without mutation', () => {
      const base: CorrelationContext = { surface: 'web', chatId: 'c1' };
      const patch: CorrelationContext = { runId: 'r42' };

      const next = extendCorrelation(base, patch);

      expect(next).toEqual({ surface: 'web', chatId: 'c1', runId: 'r42' });
      // Inputs are untouched.
      expect(base).toEqual({ surface: 'web', chatId: 'c1' });
      expect(patch).toEqual({ runId: 'r42' });
    });

    it('patch fields override base fields when defined', () => {
      const base: CorrelationContext = { runId: 'old' };
      const patch: CorrelationContext = { runId: 'new' };
      expect(extendCorrelation(base, patch).runId).toBe('new');
    });

    it('undefined patch fields do NOT clear base fields', () => {
      const base: CorrelationContext = { runId: 'keep-me' };
      const patch: CorrelationContext = { runId: undefined, chatId: 'c1' };
      const next = extendCorrelation(base, patch);
      expect(next.runId).toBe('keep-me');
      expect(next.chatId).toBe('c1');
    });

    it('works off an empty base', () => {
      const next = extendCorrelation(EMPTY_CORRELATION_CONTEXT, {
        surface: 'cli',
        sessionId: 's1',
      });
      expect(next).toEqual({ surface: 'cli', sessionId: 's1' });
    });
  });

  describe('correlationToSpanAttributes', () => {
    it('emits only defined string fields using the canonical keys', () => {
      const ctx: CorrelationContext = {
        surface: 'web',
        chatId: 'c1',
        runId: 'r1',
        executionId: 'e1',
      };
      expect(correlationToSpanAttributes(ctx)).toEqual({
        'push.surface': 'web',
        'push.chat_id': 'c1',
        'push.run_id': 'r1',
        'push.execution_id': 'e1',
      });
    });

    it('skips empty-string values', () => {
      const ctx: CorrelationContext = { runId: '' };
      expect(correlationToSpanAttributes(ctx)).toEqual({});
    });

    it('returns an empty object for an empty context', () => {
      expect(correlationToSpanAttributes(EMPTY_CORRELATION_CONTEXT)).toEqual({});
    });
  });

  describe('hasAnyCorrelation / hasRunCorrelation', () => {
    it('hasAnyCorrelation is false for empty context', () => {
      expect(hasAnyCorrelation({})).toBe(false);
    });

    it('hasAnyCorrelation is true when any field is set', () => {
      expect(hasAnyCorrelation({ surface: 'sandbox' })).toBe(true);
      expect(hasAnyCorrelation({ toolCallId: 'tc1' })).toBe(true);
    });

    it('hasRunCorrelation requires a non-empty runId', () => {
      expect(hasRunCorrelation({})).toBe(false);
      expect(hasRunCorrelation({ runId: '' })).toBe(false);
      expect(hasRunCorrelation({ chatId: 'c1' })).toBe(false);
      expect(hasRunCorrelation({ runId: 'r1' })).toBe(true);
    });
  });

  describe('shape invariants', () => {
    it('CORRELATION_FIELD_NAMES covers every CorrelationContext field', () => {
      // Compile-time: `CORRELATION_FIELD_NAMES` is declared with
      // `satisfies ReadonlyArray<keyof CorrelationContext>`. This
      // test is the runtime companion that fails if someone adds a
      // new field to the interface without updating the list.
      const sample: Required<CorrelationContext> = {
        surface: 'web',
        sessionId: 's',
        chatId: 'c',
        runId: 'r',
        taskGraphId: 'tg',
        taskId: 't',
        executionId: 'e',
        toolCallId: 'tc',
      };
      const sampleKeys = Object.keys(sample).sort();
      const listedKeys = [...CORRELATION_FIELD_NAMES].sort();
      expect(listedKeys).toEqual(sampleKeys);
    });

    it('CORRELATION_SPAN_ATTRIBUTE_KEYS has a unique value for every field', () => {
      const values = Object.values(CORRELATION_SPAN_ATTRIBUTE_KEYS);
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
