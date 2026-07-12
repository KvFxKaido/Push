/**
 * TUI import-boundary ratchet.
 *
 * Goal: the TUI client layer (`cli/tui*.ts` helpers + `cli/silvery/`) should
 * consume the runtime through the daemon protocol when attached, not by
 * importing runtime-internal modules from presentational helpers. The Silvery
 * controller still owns the inline (daemonless) turn path and is allowlisted
 * explicitly below.
 *
 * This is a RATCHET, not a gate:
 *   - importing a forbidden module from a file/module pair NOT in the
 *     baseline fails — new code must route through the protocol;
 *   - a baseline entry whose import no longer exists ALSO fails — remove
 *     the entry so the ratchet only ever tightens.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CLI_DIR = path.join(import.meta.dirname, '..');

/**
 * Runtime-internal cli/ modules the TUI helper layer must not import, with the
 * protocol path that replaces each. Keys are extensionless same-directory
 * module ids (`./engine.js` and `./engine.ts` both normalize to `engine`).
 */
const FORBIDDEN_MODULES = new Map([
  ['engine', 'run turns via the daemon (send_user_message / run events), not runAssistantTurn'],
  ['session-store', 'list/load sessions via daemon RPCs (list_sessions, get_session_messages)'],
  ['context-manager', 'compaction belongs to the runtime (session_summarize RPC)'],
  ['tools', 'approval metadata should arrive on the approval_requested event, not be recomputed'],
]);

/**
 * Known allowlisted violations, pinned exactly. Sorted module ids per file.
 * Silvery's controller is the retained product TUI and still owns the inline
 * (daemonless) engine path — shrink this list when those paths move fully
 * onto daemon verbs.
 */
const BASELINE = new Map([
  ['silvery/controller.ts', ['context-manager', 'engine', 'session-store']],
]);

/** cli/tui*.ts helpers + the Silvery controller under the boundary. */
function tuiModuleFiles() {
  const top = readdirSync(CLI_DIR)
    .filter((name) => /^tui.*\.ts$/.test(name))
    .sort();
  const silvery = path.join(CLI_DIR, 'silvery');
  let silveryFiles = [];
  try {
    silveryFiles = readdirSync(silvery)
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
      .map((name) => `silvery/${name}`)
      .sort();
  } catch {
    silveryFiles = [];
  }
  return [...top, ...silveryFiles];
}

/** Strip comments so prose mentions of module paths don't count. */
function stripComments(source) {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Line comments; the lookbehind spares protocol-relative strings
      // like 'https://…' (a ':' immediately before '//').
      .replace(/(?<!:)\/\/[^\n]*/g, '')
  );
}

/**
 * All import specifiers in a module: static `import … from '…'`,
 * re-exports `export … from '…'`, bare side-effect `import '…'`, and
 * dynamic `import('…')` with a string literal.
 */
function importSpecifiers(source) {
  const stripped = stripComments(source);
  const specs = new Set();
  for (const re of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of stripped.matchAll(re)) specs.add(match[1]);
  }
  return specs;
}

/**
 * './engine.js' | '../engine.js' → 'engine'; non-cli-sibling specifiers → null.
 * Silvery lives one directory deeper, so both `./` and `../` resolve to cli/.
 */
function siblingModuleId(spec, fileName) {
  if (fileName.startsWith('silvery/')) {
    if (!spec.startsWith('../')) return null;
    const rest = spec.slice(3);
    if (rest.startsWith('../') || rest.startsWith('./')) return null;
    return rest.replace(/\.(ts|js|mjs|tsx)$/, '');
  }
  if (!spec.startsWith('./')) return null;
  return spec.slice(2).replace(/\.(ts|js|mjs)$/, '');
}

function forbiddenImportsOf(fileName) {
  const source = readFileSync(path.join(CLI_DIR, fileName), 'utf8');
  const hits = new Set();
  for (const spec of importSpecifiers(source)) {
    const id = siblingModuleId(spec, fileName);
    if (id && FORBIDDEN_MODULES.has(id)) hits.add(id);
  }
  return [...hits].sort();
}

describe('TUI import boundary (ratchet)', () => {
  const files = tuiModuleFiles();

  it('scans a plausible TUI module set', () => {
    assert.ok(
      files.some((name) => name.startsWith('tui-')),
      'expected cli/tui-* helpers in the scan set',
    );
    assert.ok(
      files.includes('silvery/controller.ts'),
      'expected cli/silvery/controller.ts in the scan set',
    );
    assert.ok(files.length >= 10, `expected the tui-* module family, found ${files.length} files`);
  });

  it('baseline entries reference scanned files and forbidden modules only', () => {
    for (const [fileName, moduleIds] of BASELINE) {
      assert.ok(
        files.includes(fileName),
        `BASELINE names ${fileName}, which is not a scanned TUI module`,
      );
      for (const id of moduleIds) {
        assert.ok(
          FORBIDDEN_MODULES.has(id),
          `BASELINE for ${fileName} names '${id}', which is not in FORBIDDEN_MODULES`,
        );
      }
    }
  });

  for (const fileName of tuiModuleFiles()) {
    it(`${fileName} imports no runtime-internal module beyond its baseline`, () => {
      const found = forbiddenImportsOf(fileName);
      const allowed = new Set(BASELINE.get(fileName) ?? []);

      const fresh = found.filter((id) => !allowed.has(id));
      assert.deepEqual(
        fresh,
        [],
        `cli/${fileName} newly imports runtime-internal module(s) ${fresh.join(', ')}. ` +
          `Route through the daemon protocol instead: ` +
          fresh.map((id) => `${id} → ${FORBIDDEN_MODULES.get(id)}`).join('; '),
      );

      const stale = [...allowed].filter((id) => !found.includes(id)).sort();
      assert.deepEqual(
        stale,
        [],
        `cli/${fileName} no longer imports ${stale.join(', ')} — tighten the ratchet by ` +
          `removing the entry from BASELINE in this test.`,
      );
    });
  }
});
