/**
 * TUI import-boundary ratchet.
 *
 * Goal: the TUI client layer (`cli/tui*.ts`) should consume the runtime
 * through the daemon protocol (`daemon-client` request/response + events),
 * not by importing runtime-internal modules directly. Today parity between
 * the TUI and the daemon is guaranteed *by construction* (same process,
 * same imports); the target state is parity *by protocol* — the point at
 * which `push.runtime.v1` provably describes a full session and a thin
 * alternate client (any language) becomes possible. See the Retained-Mode
 * TUI decision doc for the surrounding direction.
 *
 * This is a RATCHET, not a gate:
 *   - importing a forbidden module from a file/module pair NOT in the
 *     baseline fails — new code must route through the protocol;
 *   - a baseline entry whose import no longer exists ALSO fails — remove
 *     the entry so the ratchet only ever tightens.
 *
 * Presentational helpers (role-display, design-tokens, edit-diff,
 * protocol-schema types, message-envelopes, …) are NOT forbidden: a thin
 * client legitimately needs display logic. The forbidden set is the
 * runtime brain — modules whose use means the client is doing the
 * daemon's job locally. Extend FORBIDDEN_MODULES as conversions create
 * protocol replacements (e.g. `provider` once `list_providers` fully
 * covers the picker).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CLI_DIR = path.join(import.meta.dirname, '..');

/**
 * Runtime-internal cli/ modules the TUI layer must not import, with the
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
 * Known pre-existing violations, pinned exactly. Sorted module ids per
 * file. Removing an import here without deleting its entry fails the
 * stale-baseline check — the ratchet only tightens.
 *
 * cli/tui.ts is the expected long tail: it still hosts the inline
 * (daemonless) engine path, direct disk resume, in-process compaction,
 * and local approval-risk hints. Each conversion that lands must shrink
 * this list in the same PR.
 */
const BASELINE = new Map([['tui.ts', ['context-manager', 'engine', 'session-store', 'tools']]]);

/** cli/tui*.ts — the TUI client layer under the boundary. */
function tuiModuleFiles() {
  return readdirSync(CLI_DIR)
    .filter((name) => /^tui.*\.ts$/.test(name))
    .sort();
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

/** './engine.js' | './engine.ts' → 'engine'; non-sibling specifiers → null. */
function siblingModuleId(spec) {
  if (!spec.startsWith('./')) return null;
  return spec.slice(2).replace(/\.(ts|js|mjs)$/, '');
}

function forbiddenImportsOf(fileName) {
  const source = readFileSync(path.join(CLI_DIR, fileName), 'utf8');
  const hits = new Set();
  for (const spec of importSpecifiers(source)) {
    const id = siblingModuleId(spec);
    if (id && FORBIDDEN_MODULES.has(id)) hits.add(id);
  }
  return [...hits].sort();
}

describe('TUI import boundary (ratchet)', () => {
  const files = tuiModuleFiles();

  it('scans a plausible TUI module set', () => {
    // Guard the scanner itself: if the glob or directory layout changes
    // and this list collapses, every check below would vacuously pass.
    assert.ok(files.includes('tui.ts'), 'expected cli/tui.ts in the scan set');
    assert.ok(files.length >= 10, `expected the tui-* module family, found ${files.length} files`);
  });

  it('baseline entries reference scanned files and forbidden modules only', () => {
    for (const [fileName, moduleIds] of BASELINE) {
      assert.ok(
        files.includes(fileName),
        `BASELINE names ${fileName}, which is not a cli/tui*.ts module`,
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
