import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  COMPACTION_CAUSES,
  COMPACTION_PHASES,
  PROMPT_SNAPSHOT_ROLES,
  PROTOCOL_VERSION,
  RUN_COMPLETE_OUTCOMES,
  SCHEMA_VALIDATED_EVENT_TYPES,
  SUBAGENT_AGENTS,
  TASK_GRAPH_AGENTS,
  validateRunEventPayload,
} from '../../lib/protocol-schema.ts';
import { PUSH_RUNTIME_EVENT_SCHEMA, TYPE_TO_DEF } from '../../lib/protocol-json-schema.ts';

// The published JSON Schema (lib/protocol-json-schema.ts) is a *parallel*
// artifact to the runtime validators (lib/protocol-schema.ts). These tests
// are the drift guard that keeps the two honest:
//
//   1. Coverage: the schema describes exactly the event types the
//      validators schema-validate — no more, no less.
//   2. Enums: every enum in the schema is built from the same canonical
//      constant the validators use, so the lists can't diverge.
//   3. Required fields: each field the schema marks required is a field
//      the matching validator actually rejects when absent — and a
//      payload that satisfies the schema's required set passes the
//      validator.
//   4. Artifact: the committed schema/*.json equals the builder output.

// ---------------------------------------------------------------------------
// 1. Coverage drift
// ---------------------------------------------------------------------------

describe('JSON schema event-type coverage', () => {
  it('TYPE_TO_DEF covers exactly SCHEMA_VALIDATED_EVENT_TYPES', () => {
    const schemaTypes = Object.keys(TYPE_TO_DEF).sort();
    const validatedTypes = [...SCHEMA_VALIDATED_EVENT_TYPES].sort();
    assert.deepEqual(
      schemaTypes,
      validatedTypes,
      'The published JSON schema and the runtime validators disagree on which ' +
        'event types are pinned.\n' +
        'If you added a payload validator to lib/protocol-schema.ts, add a ' +
        'matching entry to TYPE_TO_DEF in lib/protocol-json-schema.ts (and a ' +
        '$def for it). If you removed one, drop its TYPE_TO_DEF entry.\n' +
        'Then run `npm run gen:schema`.',
    );
  });

  it('every TYPE_TO_DEF target resolves to a $def', () => {
    const defs = PUSH_RUNTIME_EVENT_SCHEMA.$defs ?? {};
    const missing = [...new Set(Object.values(TYPE_TO_DEF))].filter((d) => !(d in defs)).sort();
    assert.deepEqual(missing, [], `TYPE_TO_DEF points at $defs that do not exist: ${missing}`);
  });

  it('every $def is referenced by at least one event type', () => {
    const used = new Set(Object.values(TYPE_TO_DEF));
    const orphans = Object.keys(PUSH_RUNTIME_EVENT_SCHEMA.$defs ?? {})
      .filter((d) => !used.has(d))
      .sort();
    assert.deepEqual(orphans, [], `Unreferenced $defs in the schema: ${orphans}`);
  });
});

// ---------------------------------------------------------------------------
// 2. Envelope + enum drift
// ---------------------------------------------------------------------------

describe('JSON schema envelope contract', () => {
  it('pins the protocol version as a const', () => {
    assert.equal(PUSH_RUNTIME_EVENT_SCHEMA.properties.v.const, PROTOCOL_VERSION);
  });

  it('requires the envelope fields validateEventEnvelope requires', () => {
    // Mirrors the required set in lib/protocol-schema.ts:validateEventEnvelope
    // (runId is the one optional field — present-or-absent, never null).
    assert.deepEqual([...PUSH_RUNTIME_EVENT_SCHEMA.required].sort(), [
      'kind',
      'payload',
      'seq',
      'sessionId',
      'ts',
      'type',
      'v',
    ]);
    assert.equal(PUSH_RUNTIME_EVENT_SCHEMA.required.includes('runId'), false);
    assert.ok('runId' in PUSH_RUNTIME_EVENT_SCHEMA.properties);
  });

  it('fixes kind to "event" (relay-control kinds are out of scope)', () => {
    assert.equal(PUSH_RUNTIME_EVENT_SCHEMA.properties.kind.const, 'event');
  });
});

describe('JSON schema enums are built from canonical constants', () => {
  const defs = PUSH_RUNTIME_EVENT_SCHEMA.$defs;
  const cases = [
    ['SubagentStarted', 'agent', SUBAGENT_AGENTS],
    ['TaskGraphTaskReadyOrStarted', 'agent', TASK_GRAPH_AGENTS],
    ['ContextCompaction', 'phase', COMPACTION_PHASES],
    ['ContextCompaction', 'cause', COMPACTION_CAUSES],
    ['AssistantPromptSnapshot', 'role', PROMPT_SNAPSHOT_ROLES],
    ['RunComplete', 'outcome', RUN_COMPLETE_OUTCOMES],
  ];
  for (const [def, field, canonical] of cases) {
    it(`${def}.${field} enum matches its source constant`, () => {
      assert.deepEqual(defs[def].properties[field].enum, [...canonical]);
    });
  }
});

describe('JSON schema tool render payload', () => {
  it('declares the forward-compatible card envelope on ToolResult', () => {
    const card = PUSH_RUNTIME_EVENT_SCHEMA.$defs.ToolResult.properties.card;
    assert.deepEqual(card.required, ['type', 'data']);
    assert.equal(card.properties.type.minLength, 1);
    assert.equal(card.properties.data.type, 'object');
  });
});

// ---------------------------------------------------------------------------
// 3. Required-field agreement with the validators
// ---------------------------------------------------------------------------

/** Produce a minimal value that satisfies a leaf/array/object schema node. */
function sampleFromNode(node) {
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum)) return node.enum[0];
  switch (node.type) {
    case 'string':
      return 'x';
    case 'integer':
      return typeof node.minimum === 'number' ? node.minimum : 0;
    case 'number':
      return typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return false;
    case 'array':
      return [sampleFromNode(node.items ?? { type: 'string', minLength: 1 })];
    case 'object': {
      // Recurse into structured objects so a nested required object with
      // its own fixed required sub-properties produces a value that is
      // genuinely valid against the published JSON Schema — not just the
      // TS validator. Objects without declared `properties` (e.g.
      // `additionalProperties` maps like prompt_snapshot `sections`)
      // stay `{}`, which validates fine.
      const obj = {};
      if (node.properties) {
        for (const key of effectiveRequired(node)) {
          obj[key] = sampleFromNode(node.properties[key]);
        }
      }
      return obj;
    }
    default:
      return 'x';
  }
}

/** The keys a valid payload must carry: `required` plus, for anyOf-style
 *  "at least one of" defs (warning/status), the first anyOf branch. */
function effectiveRequired(def) {
  const base = Array.isArray(def.required) ? [...def.required] : [];
  if (Array.isArray(def.anyOf) && def.anyOf[0] && Array.isArray(def.anyOf[0].required)) {
    base.push(...def.anyOf[0].required);
  }
  return base;
}

/** Build a payload populated for exactly the effective-required keys. */
function buildValidPayload(def) {
  const payload = {};
  for (const key of effectiveRequired(def)) {
    payload[key] = sampleFromNode(def.properties[key]);
  }
  return payload;
}

describe('JSON schema required fields agree with the validators', () => {
  for (const eventType of SCHEMA_VALIDATED_EVENT_TYPES) {
    const def = PUSH_RUNTIME_EVENT_SCHEMA.$defs[TYPE_TO_DEF[eventType]];

    it(`${eventType}: a schema-valid payload passes the validator`, () => {
      const payload = buildValidPayload(def);
      const issues = validateRunEventPayload(eventType, payload);
      assert.deepEqual(
        issues,
        [],
        `validateRunEventPayload rejected a payload built from the schema's ` +
          `required fields for "${eventType}": ${JSON.stringify(issues)}\n` +
          `payload=${JSON.stringify(payload)}`,
      );
    });

    it(`${eventType}: dropping any required field makes the validator reject`, () => {
      const required = effectiveRequired(def);
      for (const key of required) {
        const payload = buildValidPayload(def);
        delete payload[key];
        const issues = validateRunEventPayload(eventType, payload);
        assert.ok(
          issues.length > 0,
          `Schema marks "${key}" required on "${eventType}", but the validator ` +
            `accepted a payload without it — the schema over-constrains relative ` +
            `to the runtime contract.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Committed artifact is in sync with the builder
// ---------------------------------------------------------------------------

describe('committed schema artifact', () => {
  it('schema/<version>.event.schema.json equals the builder output', () => {
    const artifactPath = path.join(
      import.meta.dirname,
      '..',
      '..',
      'schema',
      `${PROTOCOL_VERSION}.event.schema.json`,
    );
    const onDisk = readFileSync(artifactPath, 'utf8');
    const expected = `${JSON.stringify(PUSH_RUNTIME_EVENT_SCHEMA, null, 2)}\n`;
    assert.equal(
      onDisk,
      expected,
      'The committed JSON schema is stale. Run `npm run gen:schema` and commit ' +
        'schema/push.runtime.v1.event.schema.json.',
    );
  });
});
