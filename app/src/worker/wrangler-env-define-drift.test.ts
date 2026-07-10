/**
 * Drift guard: every `import.meta.env.VITE_*` read in client code must have a
 * matching entry in wrangler.jsonc's `define` shim.
 *
 * `import.meta.env` is a Vite-ism — the Worker runtime doesn't have it. Client
 * modules still reach the Worker bundle via transitive imports (e.g.
 * `coder-job-do.ts` → `@/lib/web-search-tools`, and
 * `orchestrator-provider-routing.ts` → `xai-stream` / `model-catalog`), so an
 * unshimmed `import.meta.env.VITE_X` read at module load crashes
 * `wrangler versions upload` validation with
 * `TypeError: Cannot read properties of undefined (reading 'VITE_X')`.
 *
 * wrangler.jsonc enumerates each `VITE_*` as an empty string in `define` to
 * neutralize this. That list carried only a hand-written "keep in sync" comment,
 * which silently drifted when the xAI provider landed (`VITE_XAI_API_KEY` was
 * referenced but never defined → prod deploy TypeError). This test turns that
 * comment into a CI-enforced invariant.
 *
 * Direction: references ⊆ defines (the crash-preventing direction). The reverse
 * (dead defines) is intentionally NOT asserted — an extra shim is harmless, and
 * some vars are set at build time without a TS reference.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const APP_SRC = resolve(HERE, '..'); // app/src
const WRANGLER = resolve(REPO_ROOT, 'wrangler.jsonc');

// A `VITE_*` member read anywhere in a source file.
const VITE_REF = /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g;
// A `"import.meta.env.VITE_*":` key in the wrangler.jsonc `define` block.
const VITE_DEFINE_KEY = /"import\.meta\.env\.(VITE_[A-Z0-9_]+)"\s*:/g;

function matchNames(text: string, source: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(source, 'g'))) out.add(m[1]);
  return out;
}

/** var name → repo-relative files that reference it. */
function collectReferences(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const files = [
    ...(readdirSync(APP_SRC, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f))
      .map((f) => join(APP_SRC, f)),
    resolve(REPO_ROOT, 'app/worker.ts'), // the Worker entry itself
  ];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of matchNames(text, VITE_REF.source)) {
      const list = refs.get(name) ?? [];
      list.push(file.replace(`${REPO_ROOT}/`, ''));
      refs.set(name, list);
    }
  }
  return refs;
}

describe('wrangler.jsonc import.meta.env define drift guard', () => {
  const defined = matchNames(readFileSync(WRANGLER, 'utf8'), VITE_DEFINE_KEY.source);
  const referenced = collectReferences();

  it('is actually reading the wrangler.jsonc define block (no silent no-op)', () => {
    // A path/regex mistake would leave `defined` empty and vacuously pass the
    // main assertion, so pin known-present state.
    expect(defined.has('VITE_XAI_API_KEY')).toBe(true);
    expect(defined.size).toBeGreaterThan(10);
    expect(referenced.size).toBeGreaterThan(5);
  });

  it('every referenced VITE_* var has a define shim', () => {
    const missing = [...referenced.keys()]
      .filter((name) => !defined.has(name))
      .sort()
      .map((name) => `  ${name}  (in ${referenced.get(name)!.sort().join(', ')})`);
    expect(
      missing,
      'These import.meta.env.VITE_* vars are read in client code but missing from the ' +
        'wrangler.jsonc "define" block, so they crash the Worker deploy at module load. ' +
        'Add `"import.meta.env.<VAR>": "\\"\\""` for each:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });
});
