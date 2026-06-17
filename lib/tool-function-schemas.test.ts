import { describe, expect, it } from 'vitest';
import { getAllToolSpecs } from './tool-registry.js';
import type { ToolRegistrySource } from './tool-registry.js';
import {
  getToolFunctionSchemas,
  getToolFunctionSchemasForSources,
  toolSpecToFunctionSchema,
} from './tool-function-schemas.js';

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

describe('getToolFunctionSchemasForSources', () => {
  it('returns only schemas whose tool source is in the set', () => {
    const sources = new Set<ToolRegistrySource>(['sandbox', 'web-search']);
    const schemas = getToolFunctionSchemasForSources(sources);
    const specBySource = new Map(getAllToolSpecs().map((s) => [s.publicName, s.source]));
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(sources.has(specBySource.get(schema.function.name)!)).toBe(true);
    }
  });

  it('excludes unwired sources (e.g. delegate) so a native call cannot no-op', () => {
    // The lead has no delegation arc; advertising delegate_* as native
    // functions would let a native call slip past the detectors. The lead's
    // wired surface must not include them.
    const leadSources = new Set<ToolRegistrySource>([
      'sandbox',
      'web-search',
      'github',
      'ask-user',
      'artifacts',
    ]);
    const names = getToolFunctionSchemasForSources(leadSources).map((s) => s.function.name);
    expect(names).toContain('exec'); // sandbox
    expect(names).toContain('pr'); // github
    expect(names).not.toContain('coder'); // delegate
    expect(names).not.toContain('explorer'); // delegate
    expect(names).not.toContain('plan_tasks'); // delegate
  });

  it('pins GitHub `repo` to the active repo when provided (anti-placeholder)', () => {
    const sources = new Set<ToolRegistrySource>(['github', 'sandbox']);
    const schemas = getToolFunctionSchemasForSources(sources, { activeRepo: 'KvFxKaido/Push' });
    const byName = Object.fromEntries(schemas.map((s) => [s.function.name, s]));
    // GitHub tool: repo pinned via enum + description.
    const repoProp = byName.commits.function.parameters.properties.repo;
    expect(repoProp.enum).toEqual(['KvFxKaido/Push']);
    expect(repoProp.description).toContain('KvFxKaido/Push');
    // Non-GitHub tool: a `path`-style arg is untouched (no enum leakage).
    expect(byName.exec.function.parameters.properties.command.enum).toBeUndefined();
  });

  it('leaves `repo` unconstrained when no active repo is provided', () => {
    const schemas = getToolFunctionSchemasForSources(new Set<ToolRegistrySource>(['github']));
    const repoProp = schemas.find((s) => s.function.name === 'commits')!.function.parameters
      .properties.repo;
    expect(repoProp.enum).toBeUndefined();
    expect(repoProp).toEqual({ type: 'string' });
  });
});
