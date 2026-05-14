/**
 * Drift detector for the kernel role-capability invariant (audit item
 * #3 from the OpenCode silent-failure inventory).
 *
 * `ToolExecutionContext.role` is required at the TypeScript level so
 * tsgo catches missing-role bindings in TS code. JS callers (CLI
 * engine, pushd daemon, mjs tests) escape compile-time enforcement;
 * this test scans those files statically and asserts every
 * `executeToolCall(` invocation either:
 *   - passes a `role:` key in an options bag, OR
 *   - is wrapped by a local helper that injects a default role.
 *
 * The runtime kernel ALSO returns `ROLE_REQUIRED` if role is missing
 * (in `cli/tools.ts:executeToolCall`), so the production code is
 * fail-closed even if this test misses a caller. This is the second
 * line of defense — it surfaces the regression at PR time instead of
 * runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Production CLI surfaces that must carry an explicit role on every
 * `executeToolCall(...)` invocation. Test files are intentionally NOT
 * scanned here — they install a local `_rawExecuteToolCall` wrapper at
 * the top of the file that injects a default role, so their bare
 * `executeToolCall(...)` calls route through the wrapper (not the
 * production export). The wrapper is the proof that test callers are
 * covered; the runtime fallback test below is the second line of
 * defense.
 */
const SCAN_TARGETS = ['cli/engine.ts', 'cli/pushd.ts'];

/**
 * Per-line allowlist patterns. A line is exempt if ANY of these
 * regexes matches it. Regex (not `String.includes`) so substring
 * collisions can't silently swallow real call sites — e.g. an inlined
 * call list `[..., executeToolCall, ...]` on the same line as a real
 * invocation would have evaded the includes-based check (Copilot review
 * on PR #546). Word boundaries / anchored shapes keep each pattern
 * tight to its intended context.
 */
const LINE_ALLOWLIST_PATTERNS = [
  // Doc/comment references to the tool name (single backticks or `* `
  // prefix at the start of a JSDoc continuation).
  /^\s*\*\s.*`executeToolCall/,
  /^\s*\/\/.*`executeToolCall/,
  // Bare backtick-quoted references in any prose line.
  /`executeToolCall`/,
  // The function declaration itself.
  /^\s*export\s+async\s+function\s+executeToolCall\b/,
  // Named import lines — must be inside an `import { ... }` block.
  /^\s*import\s*\{[^}]*\bexecuteToolCall\b[^}]*\}\s*from/,
  // Property access (member call, never the direct executor): `.executeToolCall(`.
  /\.executeToolCall\s*\(/,
];

/**
 * Determine whether the given source position is part of a property
 * access (`obj.executeToolCall(...)`) rather than a direct call. The
 * static call we care about starts at the `e` of `executeToolCall`;
 * if the character immediately before is `.` (with optional
 * whitespace), it's a member access on some other receiver and not
 * the imported `executeToolCall` we're auditing.
 */
function isPropertyAccessAt(source, idx) {
  let j = idx - 1;
  while (j >= 0 && (source[j] === ' ' || source[j] === '\t')) j--;
  return j >= 0 && source[j] === '.';
}

/**
 * Find the matching close paren for `executeToolCall(` starting at
 * `start` (the index of `(`). Returns the index of the matching `)` or
 * -1 if unmatched.
 */
function findMatchingClose(source, start) {
  let depth = 0;
  let inStr = null;
  let escaped = false;
  let lc = false;
  let bc = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (lc) {
      if (c === '\n') lc = false;
      continue;
    }
    if (bc) {
      if (c === '*' && n === '/') {
        bc = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') {
      lc = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      bc = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineForOffset(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function findLineText(source, offset) {
  let start = offset;
  while (start > 0 && source[start - 1] !== '\n') start--;
  let end = offset;
  while (end < source.length && source[end] !== '\n') end++;
  return source.slice(start, end);
}

describe('kernel role-capability drift detector', () => {
  for (const rel of SCAN_TARGETS) {
    it(`every executeToolCall(...) in ${rel} passes a role`, async () => {
      const full = path.join(REPO_ROOT, rel);
      const src = await fs.readFile(full, 'utf8');

      // Match `executeToolCall(` with a non-identifier character (or
      // start of string) immediately before — protects against partial
      // matches like `myExecuteToolCall(` or `nottheExecuteToolCall(`.
      const callRegex = /(^|[^A-Za-z0-9_$])executeToolCall\s*\(/g;
      const issues = [];
      let match;
      while ((match = callRegex.exec(src)) !== null) {
        // `idx` points at the `e` of `executeToolCall`.
        const idx = match.index + match[1].length;
        const lineText = findLineText(src, idx);

        if (isPropertyAccessAt(src, idx)) continue;
        if (LINE_ALLOWLIST_PATTERNS.some((re) => re.test(lineText))) continue;

        // `(` is the last char of the match; the call body starts
        // right after it.
        const openIdx = match.index + match[0].length;
        const closeIdx = findMatchingClose(src, openIdx - 1);
        if (closeIdx === -1) {
          issues.push({
            line: lineForOffset(src, idx),
            text: lineText.trim(),
            reason: 'unbalanced parens — cannot validate',
          });
          continue;
        }

        const callBody = src.slice(openIdx, closeIdx);
        if (!/\brole\s*:/.test(callBody)) {
          issues.push({
            line: lineForOffset(src, idx),
            text: lineText.trim(),
            reason: 'missing role in arguments',
          });
        }
      }

      assert.deepEqual(
        issues,
        [],
        `Found ${issues.length} executeToolCall(...) call site(s) without a role in ${rel}. ` +
          `Every binding must pass role to satisfy the kernel role-capability invariant ` +
          `(audit item #3 from the OpenCode silent-failure inventory). ` +
          `Details:\n${JSON.stringify(issues, null, 2)}`,
      );
    });
  }

  it('the CLI kernel returns ROLE_REQUIRED when invoked without role (runtime fallback)', async () => {
    // Belt-and-braces: even if the static scan above misses a caller,
    // the runtime kernel in `cli/tools.ts:executeToolCall` returns a
    // structured ROLE_REQUIRED error rather than admitting the call.
    // Pin that behavior by exercising the executor directly. The kernel
    // role check fires before any filesystem access, so REPO_ROOT is
    // fine as the workspace argument — no tempdir needed.
    const { executeToolCall } = await import('../tools.ts');
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'package.json' } },
      REPO_ROOT,
      {}, // no role
    );
    assert.equal(result.ok, false, 'kernel must refuse when role is missing');
    assert.equal(result.structuredError?.code, 'ROLE_REQUIRED');
  });

  it('the CLI kernel returns ROLE_INVALID when given an unknown role string', async () => {
    // Companion to the ROLE_REQUIRED pin above. The kernel now
    // distinguishes "no role" from "role declared but unknown" so the
    // diagnostic is accurate. Both branches fail-closed.
    const { executeToolCall } = await import('../tools.ts');
    const result = await executeToolCall(
      { tool: 'read_file', args: { path: 'package.json' } },
      REPO_ROOT,
      { role: 'definitely-not-a-real-role' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'ROLE_INVALID');
  });
});
