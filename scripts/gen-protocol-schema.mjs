#!/usr/bin/env node
/**
 * gen-protocol-schema.mjs — Emit the committed JSON Schema artifact for
 * the `push.runtime.v1` event envelope from the builder in
 * `lib/protocol-json-schema.ts`.
 *
 * The emitted file (`schema/push.runtime.v1.event.schema.json`) is the
 * publishable, language-agnostic description of the event contract —
 * hand it to Stainless/quicktype, an external validator, or a docs site.
 * It is checked in so consumers don't need a build step, and a drift
 * test (`cli/tests/protocol-json-schema.test.mjs`) fails CI if the
 * committed file falls out of sync with the builder.
 *
 * Run: `npm run gen:schema` (or `node --import tsx scripts/gen-protocol-schema.mjs`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PUSH_RUNTIME_EVENT_SCHEMA } from '../lib/protocol-json-schema.ts';

const outDir = path.join(import.meta.dirname, '..', 'schema');
const outPath = path.join(outDir, 'push.runtime.v1.event.schema.json');

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `${JSON.stringify(PUSH_RUNTIME_EVENT_SCHEMA, null, 2)}\n`);

console.log(`wrote ${path.relative(path.join(import.meta.dirname, '..'), outPath)}`);
