import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const cliDir = path.resolve(import.meta.dirname, '..');
const facadePath = path.join(cliDir, 'pushd.ts');
const facadeBasePath = path.join(cliDir, 'pushd');
const internalDir = path.join(cliDir, 'pushd');
const facadeSource = readFileSync(facadePath, 'utf8');

// Phase 7 baseline is 925 lines after removing @ts-nocheck and typing the
// residual composition boundary. Twenty-five lines of headroom permits small
// wiring additions without letting handler or coordinator logic quietly return.
const MAX_PUSHD_LINES = 950;

function lineCount(source) {
  const count = source.split(/\r?\n/).length;
  return source.endsWith('\n') ? count - 1 : count;
}

function collectTypeScriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

function moduleSpecifiers(source) {
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
}

describe('pushd spine containment', () => {
  it('keeps the composition facade near its Phase 7 baseline', () => {
    const actual = lineCount(facadeSource);
    assert.ok(
      actual <= MAX_PUSHD_LINES,
      `cli/pushd.ts grew to ${actual} lines (limit ${MAX_PUSHD_LINES}); move new behavior into cli/pushd/`,
    );
  });

  it('does not restore a file-wide TypeScript suppression', () => {
    assert.doesNotMatch(
      facadeSource,
      /@ts-nocheck/,
      'cli/pushd.ts must remain under strict CLI typechecking',
    );
  });

  it('recognizes every import form used to cross a module boundary', () => {
    assert.deepEqual(
      moduleSpecifiers(`
        import value from './static.js';
        export { value } from './re-export.js';
        import './side-effect.js';
        await import('./dynamic.js');
      `),
      ['./static.js', './re-export.js', './side-effect.js', './dynamic.js'],
    );
  });

  it('keeps internal modules from importing back through the facade', () => {
    const violations = [];
    for (const file of collectTypeScriptFiles(internalDir)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of moduleSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const resolvedBase = path
          .resolve(path.dirname(file), specifier)
          .replace(/\.(?:[cm]?js|ts)$/, '');
        if (resolvedBase === facadeBasePath) {
          violations.push(`${path.relative(cliDir, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `cli/pushd/ modules must not import the pushd.ts facade:\n${violations.join('\n')}`,
    );
  });
});
