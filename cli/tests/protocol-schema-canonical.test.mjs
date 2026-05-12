/**
 * protocol-schema-canonical.test.mjs — Guards "one source of truth per
 * vocabulary" for the wire protocol (AGENTS.md / CLAUDE.md guardrail).
 *
 * Two assertions:
 *
 *   1. lib/protocol-schema.ts exports the surface every consumer
 *      depends on (PROTOCOL_VERSION + validators). Refactoring lib/ to
 *      remove or rename one of these would silently break the web app
 *      in PR 3; this test fails-closed instead.
 *
 *   2. app/src/ does not contain a duplicate of the wire-version
 *      literal or any validator-shaped function. The web app must
 *      import from lib/protocol-schema rather than re-define the
 *      contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION,
  SCHEMA_VALIDATED_EVENT_TYPES,
  assertValidEvent,
  isStrictModeEnabled,
  validateEvent,
  validateEventEnvelope,
  validateRunEventPayload,
} from '../../lib/protocol-schema.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_SRC = path.join(REPO_ROOT, 'app', 'src');

/** Recursively walk a directory, returning all file paths under it. */
async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules + build artifacts inside the app.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('protocol-schema canonical surface (lib/protocol-schema.ts)', () => {
  it('PROTOCOL_VERSION is exported and pinned', () => {
    assert.equal(typeof PROTOCOL_VERSION, 'string');
    assert.equal(PROTOCOL_VERSION, 'push.runtime.v1');
  });

  it('validator surface is callable', () => {
    assert.equal(typeof validateEventEnvelope, 'function');
    assert.equal(typeof validateRunEventPayload, 'function');
    assert.equal(typeof validateEvent, 'function');
    assert.equal(typeof assertValidEvent, 'function');
    assert.equal(typeof isStrictModeEnabled, 'function');
    assert.ok(SCHEMA_VALIDATED_EVENT_TYPES instanceof Set);
    assert.ok(SCHEMA_VALIDATED_EVENT_TYPES.size > 0);
  });
});

describe('protocol-schema drift guard (app/src/)', () => {
  it('does not duplicate PROTOCOL_VERSION literal', async () => {
    const files = (await walk(APP_SRC)).filter(
      (f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && !/\.test\.(ts|tsx|mjs)$/.test(f),
    );
    const matches = [];
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      // Match the literal version string anywhere — string assignment,
      // comparison, hardcoded envelope, doesn't matter; if it shows up
      // the web app is making contract assumptions it should be
      // importing instead.
      if (raw.includes("'push.runtime.v1'") || raw.includes('"push.runtime.v1"')) {
        matches.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.equal(
      matches.length,
      0,
      `Wire-protocol version string is duplicated in app/src — import PROTOCOL_VERSION from lib/protocol-schema instead.\n  Offenders: ${matches.join(', ')}`,
    );
  });

  it('does not duplicate envelope validator function names', async () => {
    // Match any top-level binding (function, const, let) that shares a
    // canonical validator name. A `const validateEvent = ...` IS a
    // re-implementation in spirit even when expressed as an arrow
    // function, so we catch both forms. The (very low) risk of a false
    // positive is worth the broader net here: the alternative is the
    // web app shipping a quietly-divergent envelope validator.
    const validatorNames = [
      'validateEventEnvelope',
      'validateRunEventPayload',
      'validateEvent',
      'assertValidEvent',
    ];
    const definitionPatterns = validatorNames.map(
      (name) =>
        new RegExp(`(function|const|let)\\s+${name}\\s*[=(]|export\\s+function\\s+${name}\\b`),
    );

    const files = (await walk(APP_SRC)).filter(
      (f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && !/\.test\.(ts|tsx|mjs)$/.test(f),
    );
    const offenders = [];
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      for (let i = 0; i < validatorNames.length; i++) {
        if (definitionPatterns[i].test(raw)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} (defines ${validatorNames[i]})`);
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `Envelope validator is duplicated in app/src — import from lib/protocol-schema instead.\n  Offenders: ${offenders.join('\n  ')}`,
    );
  });
});
