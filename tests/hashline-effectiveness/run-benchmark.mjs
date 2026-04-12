import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { applyHashlineEdits } from '../../lib/hashline.ts';

const FIXTURE_DIR = 'tests/hashline-effectiveness/fixtures';
const buckets = ['clean', 'stale', 'moved'];

async function runControl(content, ops) {
  let result = content;
  let applied = 0;
  let failed = 0;
  const errors = [];

  for (const op of ops) {
    if (op.originalLine && result.includes(op.originalLine)) {
      result = result.replace(op.originalLine, op.content);
      applied++;
    } else {
      failed++;
      errors.push(`Control could not find: ${op.originalLine}`);
    }
  }

  return { content: result, applied, failed, errors };
}

const results = {
  date: new Date().toISOString().split('T')[0],
  fixtures: 0,
  hashline: { applied: 0, exactMatch: 0, errors: 0 },
  control: { applied: 0, exactMatch: 0, errors: 0 },
  byBucket: {},
};

async function runBenchmark() {
  for (const bucket of buckets) {
    const bucketDir = path.join(FIXTURE_DIR, bucket);
    const original = fs.readFileSync(path.join(bucketDir, 'original.txt'), 'utf8');
    const expected = fs.readFileSync(path.join(bucketDir, 'expected.txt'), 'utf8');
    const ops = JSON.parse(fs.readFileSync(path.join(bucketDir, 'edit.json'), 'utf8'));

    results.fixtures++;
    results.byBucket[bucket] = {
      hashline: { applied: 0, exactMatch: 0, errors: 0 },
      control: { applied: 0, exactMatch: 0, errors: 0 },
    };

    const hashlineResult = await applyHashlineEdits(original, ops);
    results.hashline.applied += hashlineResult.applied;
    results.hashline.errors += hashlineResult.failed;
    results.byBucket[bucket].hashline.applied = hashlineResult.applied;
    results.byBucket[bucket].hashline.errors = hashlineResult.failed;
    if (hashlineResult.content === expected) {
      results.hashline.exactMatch++;
      results.byBucket[bucket].hashline.exactMatch = 1;
    } else {
      results.byBucket[bucket].hashline.exactMatch = 0;
    }

    const controlResult = await runControl(original, ops);
    results.control.applied += controlResult.applied;
    results.control.errors += controlResult.failed;
    results.byBucket[bucket].control.applied = controlResult.applied;
    results.byBucket[bucket].control.errors = controlResult.failed;
    if (controlResult.content === expected) {
      results.control.exactMatch++;
      results.byBucket[bucket].control.exactMatch = 1;
    } else {
      results.byBucket[bucket].control.exactMatch = 0;
    }
  }

  fs.writeFileSync('tests/hashline-effectiveness/results.json', JSON.stringify(results, null, 2));
  console.log('Benchmark finished. Results written to results.json');
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
