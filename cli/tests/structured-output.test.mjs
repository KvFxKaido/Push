import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { parseStructured, stripJsonFence } from '../../lib/structured-output.ts';

// A schema shaped like the auditor verdict, exercising the `.catch` default
// pattern the role kernels rely on for behaviour-preserving coercion.
const VerdictSchema = z.object({
  verdict: z.enum(['safe', 'unsafe']).catch('unsafe'),
  summary: z.string().catch('No summary provided'),
  risks: z
    .array(
      z
        .object({
          level: z.enum(['low', 'medium', 'high']).catch('medium'),
          description: z.string().catch('Unknown risk'),
        })
        .catch({ level: 'medium', description: 'Unknown risk' }),
    )
    .catch([]),
});

describe('stripJsonFence', () => {
  it('unwraps a ```json fence', () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  });

  it('unwraps a bare ``` fence', () => {
    assert.equal(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  });

  it('returns trimmed input when no fence is present', () => {
    assert.equal(stripJsonFence('  {"a":1}  '), '{"a":1}');
  });
});

describe('parseStructured', () => {
  it('parses a clean JSON object', () => {
    const r = parseStructured('{"verdict":"safe","summary":"ok","risks":[]}', VerdictSchema);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { verdict: 'safe', summary: 'ok', risks: [] });
  });

  it('strips a markdown fence before parsing', () => {
    const r = parseStructured('```json\n{"verdict":"unsafe","summary":"x"}\n```', VerdictSchema);
    assert.equal(r.ok, true);
    assert.equal(r.data.verdict, 'unsafe');
    // Missing `risks` falls back to the schema default.
    assert.deepEqual(r.data.risks, []);
  });

  it('applies per-field defaults for malformed-but-parseable fields', () => {
    const r = parseStructured(
      '{"verdict":"maybe","risks":[{"level":"catastrophic"},"oops"]}',
      VerdictSchema,
    );
    assert.equal(r.ok, true);
    // Unknown verdict -> 'unsafe', missing summary -> default.
    assert.equal(r.data.verdict, 'unsafe');
    assert.equal(r.data.summary, 'No summary provided');
    // Unknown risk level -> 'medium'; a bare string element -> generic risk.
    assert.deepEqual(r.data.risks, [
      { level: 'medium', description: 'Unknown risk' },
      { level: 'medium', description: 'Unknown risk' },
    ]);
  });

  it('repairs common LLM garbling (trailing comma, single quotes) by default', () => {
    const r = parseStructured("{'verdict': 'safe', 'summary': 'ok',}", VerdictSchema);
    assert.equal(r.ok, true);
    assert.equal(r.data.verdict, 'safe');
    assert.equal(r.data.summary, 'ok');
  });

  it('does not repair when repair is disabled', () => {
    const r = parseStructured("{'verdict': 'safe',}", VerdictSchema, { repair: false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'json');
  });

  it('reports an "empty" failure for whitespace-only input', () => {
    const r = parseStructured('   ', VerdictSchema);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });

  it('reports a "json" failure for unparseable input', () => {
    const r = parseStructured('not json at all <<<', VerdictSchema);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'json');
  });

  it('reports a "schema" failure when JSON is a bare primitive', () => {
    const r = parseStructured('42', VerdictSchema);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema');
  });

  it('preprocess-style filtering drops non-string array members', () => {
    const GapsSchema = z.object({
      gaps: z.preprocess(
        (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string') : []),
        z.array(z.string()),
      ),
    });
    const r = parseStructured('{"gaps":["a",1,"b",null,"c"]}', GapsSchema);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.gaps, ['a', 'b', 'c']);
  });

  it('a top-level .catch makes a primitive coerce instead of failing', () => {
    const TotalSchema = z
      .object({ summary: z.string().catch('default') })
      .catch({ summary: 'default' });
    const r = parseStructured('"a bare string"', TotalSchema);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { summary: 'default' });
  });
});
