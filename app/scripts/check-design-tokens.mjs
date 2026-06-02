// Design-token ratchet: counts hardcoded colors under app/src that should use
// the DESIGN.md token system, and fails only when the count grows past a
// committed baseline. Deliberately NOT wired into eslint/CI yet — the codebase
// has a large existing backlog, so this is a standalone, non-noisy report that
// guards against regressions and ratchets down as the backlog shrinks.
//
//   npm run check:design-tokens            # check against baseline
//   npm run check:design-tokens -- --update  # rewrite baseline to current count
//
// Carveouts (app-relative paths). Entries ending in "/" are directory prefixes;
// all others are matched as exact file paths so a carveout can't silently
// swallow a neighbor (e.g. codemirror-theme.ts.test.ts):
//   - src/components/ui/ — shadcn, matching the design system's existing
//     carveout in biome.json / project conventions.
//   - src/lib/codemirror-theme.ts — CodeMirror syntax-highlight theme. These
//     are editor token colors, not DESIGN.md app tokens, so they're out of
//     scope for this ratchet. See docs/runbooks/Design Token Migration Plan.md.
//   - src/lib/language-colors.ts, src/lib/repo-appearance.ts — data colors
//     (canonical per-language badge colors; user-selectable repo accent
//     palette), not design tokens.
//   - src/components/RootErrorBoundary.tsx — crash-fallback screen that renders
//     with inline styles precisely because the stylesheet may not have loaded.
//   - *.test.ts / *.test.tsx / *.spec.* — test files. Hex in assertions is
//     test data (pinning expected values), not shipping UI, so it's out of
//     scope for this ratchet.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedColors } from './design-token-detector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');
const SRC_ROOT = join(APP_ROOT, 'src');
const BASELINE_PATH = join(HERE, 'design-token-baseline.json');
const EXCLUDE_PATHS = [
  'src/components/ui/',
  'src/lib/codemirror-theme.ts',
  'src/lib/language-colors.ts',
  'src/lib/repo-appearance.ts',
  'src/components/RootErrorBoundary.tsx',
];
const SCAN_EXT = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const TOP_OFFENDERS = 12;

// Directory carveouts (trailing "/") match by prefix; file carveouts match
// exactly, so they can't swallow a similarly-named neighbor.
function isExcluded(rel) {
  return EXCLUDE_PATHS.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

const perFile = [];
let total = 0;
let tailwind = 0;
let inlineHex = 0;
let rgbTriplet = 0;

for (const file of walk(SRC_ROOT)) {
  const rel = relative(APP_ROOT, file).split('\\').join('/');
  if (isExcluded(rel)) continue;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    // A single unreadable file (permissions, transient I/O) shouldn't crash
    // the whole scan — warn and skip so the count stays meaningful.
    console.warn(`  ! skipped unreadable file ${rel}: ${err.message}`);
    continue;
  }
  const res = findHardcodedColors(source);
  if (res.total > 0) perFile.push({ rel, ...res });
  total += res.total;
  tailwind += res.tailwind;
  inlineHex += res.inlineHex;
  rgbTriplet += res.rgbTriplet;
}

const update = process.argv.includes('--update') || process.env.UPDATE_BASELINE === '1';

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  // No baseline yet (first run, or it was deleted).
}

perFile.sort((a, b) => b.total - a.total);

console.log(
  'Design-token check (DESIGN.md) — hardcoded colors (excludes components/ui, codemirror-theme):',
);
console.log(`  Tailwind arbitrary values (e.g. bg-[#000]): ${tailwind}`);
console.log(`  Quoted hex literals (inline styles / constants): ${inlineHex}`);
console.log(`  Chromatic rgb()/rgba() triplets (use a token): ${rgbTriplet}`);
console.log(`  Total: ${total}  (baseline: ${baseline ? baseline.total : 'none'})`);
if (perFile.length > 0) {
  console.log(`  Top offenders:`);
  for (const f of perFile.slice(0, TOP_OFFENDERS)) {
    console.log(`    ${String(f.total).padStart(4)}  ${f.rel}`);
  }
}

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ total }, null, 2)}\n`);
  console.log(`\nBaseline updated to ${total}.`);
  process.exit(0);
}

if (!baseline) {
  console.log(
    `\nℹ No baseline found. Initialize it with:\n    npm run check:design-tokens -- --update`,
  );
  process.exit(0);
}

if (total > baseline.total) {
  console.error(
    `\n✖ Hardcoded colors increased: ${total} > baseline ${baseline.total}.\n` +
      `  Use DESIGN.md token classes (e.g. text-push-fg, bg-push-surface) instead of raw hex.\n` +
      `  If a new raw color is genuinely unavoidable, justify it and run:\n` +
      `    npm run check:design-tokens -- --update`,
  );
  process.exit(1);
}

if (total < baseline.total) {
  console.log(
    `\n✓ Progress — down ${baseline.total - total} from baseline. Lock it in with:\n` +
      `    npm run check:design-tokens -- --update`,
  );
} else {
  console.log('\n✓ No increase over baseline.');
}
process.exit(0);
