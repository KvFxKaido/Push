import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { constrainOutputToSchema, loadOutputSchema, validateOutputText } from '../output-schema.ts';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    count: { type: 'integer', minimum: 1 },
  },
  required: ['status', 'count'],
  additionalProperties: false,
};

async function withSchemaFile(schema, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-output-schema-'));
  try {
    await fs.writeFile(path.join(root, 'result.schema.json'), JSON.stringify(schema));
    await run(await loadOutputSchema('result.schema.json', root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('output schema validation', () => {
  it('accepts exact JSON, canonicalizes it, and rejects prose or schema violations', async () => {
    await withSchemaFile(SCHEMA, async (compiled) => {
      assert.deepEqual(validateOutputText('{ "status": "ok", "count": 2 }', compiled), {
        ok: true,
        text: '{"status":"ok","count":2}',
        value: { status: 'ok', count: 2 },
      });

      const fenced = validateOutputText('```json\n{"status":"ok","count":2}\n```', compiled);
      assert.equal(fenced.ok, false);
      assert.match(fenced.error, /not valid JSON/);

      const invalid = validateOutputText('{"status":"ok","count":0}', compiled);
      assert.equal(invalid.ok, false);
      assert.match(invalid.error, />= 1/);
    });
  });

  it('uses bounded repair calls and returns only the validated candidate', async () => {
    await withSchemaFile(SCHEMA, async (compiled) => {
      const prompts = [];
      const result = await constrainOutputToSchema(
        compiled,
        'Produce a result.',
        'not json',
        async (prompt, attempt) => {
          prompts.push(prompt);
          return attempt === 1 ? '{"status":"wrong","count":2}' : '{"status":"ok","count":2}';
        },
      );

      assert.deepEqual(result, {
        ok: true,
        text: '{"status":"ok","count":2}',
        value: { status: 'ok', count: 2 },
        repairs: 2,
      });
      assert.equal(prompts.length, 2);
      assert.match(prompts[0], /task itself has already run/);
      assert.match(prompts[1], /must be equal to one of the allowed values/);
    });
  });

  it('fails schema compilation before a run can start', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-output-schema-invalid-'));
    try {
      await fs.writeFile(path.join(root, 'bad.json'), '{"type":"not-a-type"}');
      await assert.rejects(
        loadOutputSchema('bad.json', root),
        /not a supported Draft 2020-12 schema/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
