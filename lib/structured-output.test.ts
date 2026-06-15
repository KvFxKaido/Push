import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zodToStrictJsonSchema, applyStructuredOutput } from './structured-output.ts';
import type { ResponseFormatSpec } from './provider-contract.ts';

describe('zodToStrictJsonSchema', () => {
  it('marks every object property required and sets additionalProperties:false', () => {
    const schema = zodToStrictJsonSchema(
      z.object({ a: z.string(), b: z.number(), c: z.boolean() }),
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['a', 'b', 'c']);
  });

  it('keeps .catch()/.default() fields required and non-nullable, stripping default', () => {
    const schema = zodToStrictJsonSchema(
      z.object({ verdict: z.enum(['safe', 'unsafe']).catch('unsafe') }),
    );
    expect(schema.required).toEqual(['verdict']);
    // Stays a plain string enum — the catch default is dropped, not surfaced.
    expect((schema.properties as Record<string, unknown>).verdict).toEqual({
      type: 'string',
      enum: ['safe', 'unsafe'],
    });
  });

  it('models a genuinely .optional() field as nullable + required', () => {
    const schema = zodToStrictJsonSchema(
      z.object({ name: z.string(), line: z.number().int().positive().optional() }),
    );
    expect(schema.required).toEqual(['name', 'line']);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.line.type).toEqual(['integer', 'null']);
    // A required, non-optional field is untouched.
    expect(props.name.type).toBe('string');
  });

  it('adds null to a nullable enum field', () => {
    const schema = zodToStrictJsonSchema(z.object({ pick: z.enum(['x', 'y']).optional() }));
    const props = schema.properties as Record<string, { type: unknown; enum: unknown }>;
    expect(props.pick.type).toEqual(['string', 'null']);
    expect(props.pick.enum).toEqual(['x', 'y', null]);
  });

  it('recurses into nested objects and arrays', () => {
    const schema = zodToStrictJsonSchema(
      z.object({ items: z.array(z.object({ id: z.string() })) }),
    );
    const items = (schema.properties as Record<string, { items: Record<string, unknown> }>).items
      .items;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(['id']);
  });

  it('strips the $schema keyword', () => {
    const schema = zodToStrictJsonSchema(z.object({ a: z.string() }));
    expect(schema.$schema).toBeUndefined();
  });

  it('represents a .transform() schema (input shape)', () => {
    const schema = zodToStrictJsonSchema(
      z.object({ n: z.string() }).transform((o) => ({ doubled: o.n + o.n })),
    );
    expect(schema.required).toEqual(['n']);
  });
});

describe('applyStructuredOutput', () => {
  const spec: ResponseFormatSpec = { name: 'x', schema: { type: 'object' } };

  it('returns the responseFormat fragment and logs _attached when enabled', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = applyStructuredOutput(true, spec, {
      eventBase: 'role_structured_output',
      provider: 'openrouter',
      model: 'm',
    });
    expect(out).toEqual({ responseFormat: spec });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      event: 'role_structured_output_attached',
      provider: 'openrouter',
      model: 'm',
    });
    log.mockRestore();
  });

  it('returns an empty fragment and logs _skipped when disabled', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = applyStructuredOutput(false, spec, {
      eventBase: 'role_structured_output',
      provider: 'openrouter',
    });
    expect(out).toEqual({});
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      event: 'role_structured_output_skipped',
    });
    log.mockRestore();
  });
});
