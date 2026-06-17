import { describe, expect, it } from 'vitest';
import { getAllToolSpecs } from './tool-registry.js';
import { getToolFunctionSchemas, toolSpecToFunctionSchema } from './tool-function-schemas.js';

describe('getToolFunctionSchemas', () => {
  it('emits exactly one schema per registry tool (completeness)', () => {
    // A native `tools` array must be complete — a partial list tells the model
    // those are its only tools. Pin one-to-one with the registry so a new tool
    // can't silently ship without a function schema.
    const specs = getAllToolSpecs();
    const schemas = getToolFunctionSchemas();
    expect(schemas).toHaveLength(specs.length);
    expect(new Set(schemas.map((s) => s.function.name))).toEqual(
      new Set(specs.map((s) => s.publicName)),
    );
  });

  it('names functions by publicName so flushed native calls dispatch', () => {
    // openai-sse-pump flushes a native tool_call as `{"tool": <name>}`, gated by
    // KNOWN_TOOL_NAMES (which includes publicNames) and resolved via
    // resolveToolName. publicName is the only name that satisfies both.
    const schemas = getToolFunctionSchemas();
    const exec = schemas.find((s) => s.function.name === 'exec');
    expect(exec).toBeDefined();
    expect(exec?.function.parameters.required).toContain('command');
  });

  it('includes every signature parameter in the schema with correct required flags', () => {
    for (const spec of getAllToolSpecs()) {
      const schema = toolSpecToFunctionSchema(spec);
      const props = schema.function.parameters.properties;
      const required = schema.function.parameters.required;
      const open = spec.protocolSignature.indexOf('(');
      const close = spec.protocolSignature.lastIndexOf(')');
      const inner = spec.protocolSignature.slice(open + 1, close).trim();
      const tokens = inner ? inner.split(',').map((t) => t.trim()) : [];
      for (const token of tokens) {
        const optional = token.endsWith('?');
        const name = optional ? token.slice(0, -1).trim() : token;
        expect(props).toHaveProperty(name);
        expect(required.includes(name)).toBe(!optional);
      }
      // additionalProperties locked off for predictable native calls.
      expect(schema.function.parameters.additionalProperties).toBe(false);
    }
  });

  it('types known non-string args (numbers, booleans, arrays) from the curated map', () => {
    const byName = Object.fromEntries(getToolFunctionSchemas().map((s) => [s.function.name, s]));
    // integer
    expect(byName.pr.function.parameters.properties.pr.type).toBe('integer');
    expect(byName.read.function.parameters.properties.start_line.type).toBe('integer');
    // boolean
    expect(byName.show_commit.function.parameters.properties.stat.type).toBe('boolean');
    // string array (items typed)
    expect(byName.explorer.function.parameters.properties.files).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    // object array
    expect(byName.plan_tasks.function.parameters.properties.tasks).toEqual({
      type: 'array',
      items: { type: 'object' },
    });
  });
});
