// Design-token ratchet: counts hardcoded colors under app/src that should use
// the DESIGN.md token system, and fails only when the count grows past a
// committed baseline. Deliberately NOT wired into eslint/CI yet — the codebase
// has a large existing backlog, so this is a standalone, non-noisy report that
// guards against regressions and ratchets down as the backlog shrinks.
//
//   npm run check:design-tokens            # check against baseline
//   npm run check:design-tokens -- --update  # rewrite baseline to current count
//
// Carveout: src/components/ui/** (shadcn) is excluded, matching the design
// system's existing carveout in biome.json / project conventions.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedColors } from './design-token-detector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..');
const SRC_ROOT = join(APP_ROOT, 'src');
const BASELINE_PATH = join(HERE, 'design-token-baseline.json');
const EXCLUDE_PREFIX = 'src/components/ui/';
const SCAN_EXT = new Set(['.ts', '.tsx']);
const TOP_OFFENDERS = 12;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(extname(entry.name))) out.push(full);
  }
  return out;
}

const perFile = [];
let total = 0;
let tailwind = 0;
let inlineHex = 0;

for (const file of walk(SRC_ROOT)) {
  const rel = relative(APP_ROOT, file).split('\\').join('/');
  if (rel.startsWith(EXCLUDE_PREFIX)) continue;
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
}

const update = process.argv.includes('--update') || process.env.UPDATE_BASELINE === '1';

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  // No baseline yet (first run, or it was deleted).
}

perFile.sort((a, b) => b.total - a.total);

console.log('Design-token check (DESIGN.md) — hardcoded colors outside src/components/ui:');
console.log(`  Tailwind arbitrary values (e.g. bg-[#000]): ${tailwind}`);
console.log(`  Quoted hex literals (inline styles / constants): ${inlineHex}`);
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
