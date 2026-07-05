import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isBunRuntime,
  pushdLoaderArgs,
  pushdSpawnPlan,
  resolvePushdEntryCandidate,
} from '../daemon-spawn-args.ts';

describe('pushdLoaderArgs', () => {
  it('injects the tsx loader for a .ts entry under Node', () => {
    assert.deepEqual(pushdLoaderArgs({ underBun: false, ext: 'ts' }), ['--import', 'tsx']);
  });

  it('injects the tsx loader for a .mts entry under Node', () => {
    // cli.ts previously only special-cased 'ts', silently missing '.mts';
    // the shared helper covers both.
    assert.deepEqual(pushdLoaderArgs({ underBun: false, ext: 'mts' }), ['--import', 'tsx']);
  });

  it('runs .js/.mjs directly under Node (no loader)', () => {
    assert.deepEqual(pushdLoaderArgs({ underBun: false, ext: 'js' }), []);
    assert.deepEqual(pushdLoaderArgs({ underBun: false, ext: 'mjs' }), []);
  });

  it('never injects tsx under Bun — it would crash on tsx/cjs/index.cjs', () => {
    // The core regression: `bun --import tsx pushd.ts` dies with
    // "Cannot find module './cjs/index.cjs' from ''". Assert tsx is absent
    // for every entry extension, since Bun runs TS natively.
    for (const ext of ['ts', 'mts', 'js', 'mjs', null]) {
      const args = pushdLoaderArgs({ underBun: true, ext });
      assert.ok(!args.includes('tsx'), `tsx leaked into Bun argv for ext=${ext}`);
      assert.ok(!args.includes('--import'), `--import leaked into Bun argv for ext=${ext}`);
    }
  });

  it('passes --no-env-file under Bun to block cwd .env autoload', () => {
    // Matches the compiled-binary env model in the Bun Adoption doc.
    assert.deepEqual(pushdLoaderArgs({ underBun: true, ext: 'ts' }), ['--no-env-file']);
  });

  it('tolerates a null extension', () => {
    assert.deepEqual(pushdLoaderArgs({ underBun: false, ext: null }), []);
  });
});

describe('resolvePushdEntryCandidate', () => {
  it('derives the sibling pushd path from the current entry extension', () => {
    const cliPath = path.join(os.tmpdir(), 'Push With Space', 'cli', 'cli.ts');
    const candidate = resolvePushdEntryCandidate(pathToFileURL(cliPath).href);

    assert.deepEqual(candidate, {
      ext: 'ts',
      path: path.join(os.tmpdir(), 'Push With Space', 'cli', 'pushd.ts'),
    });
  });

  it('returns nulls when the entry URL has no runnable source extension', () => {
    assert.deepEqual(resolvePushdEntryCandidate('file:///tmp/push/cli/cli'), {
      ext: null,
      path: null,
    });
  });
});

describe('pushdSpawnPlan', () => {
  it('uses script mode when the sibling pushd entry exists', () => {
    const plan = pushdSpawnPlan({
      underBun: false,
      ext: 'ts',
      path: '/repo/cli/pushd.ts',
      pathExists: true,
    });

    assert.deepEqual(plan, {
      mode: 'script',
      args: ['--import', 'tsx', '/repo/cli/pushd.ts'],
      entry: '/repo/cli/pushd.ts',
    });
  });

  it('keeps Bun script mode free of the tsx loader', () => {
    const plan = pushdSpawnPlan({
      underBun: true,
      ext: 'ts',
      path: '/repo/cli/pushd.ts',
      pathExists: true,
    });

    assert.deepEqual(plan, {
      mode: 'script',
      args: ['--no-env-file', '/repo/cli/pushd.ts'],
      entry: '/repo/cli/pushd.ts',
    });
  });

  it('self-execs when a compiled runtime reports a virtual sibling path', () => {
    const plan = pushdSpawnPlan({
      underBun: true,
      ext: 'mjs',
      path: '/virtual/bun/root/pushd.mjs',
      pathExists: false,
    });

    assert.deepEqual(plan, {
      mode: 'self-exec',
      args: ['daemon', '__run'],
      pushdPathChecked: '/virtual/bun/root/pushd.mjs',
    });
  });

  it('self-execs when no sibling entry can be derived', () => {
    const plan = pushdSpawnPlan({
      underBun: false,
      ext: null,
      path: null,
      pathExists: false,
    });

    assert.deepEqual(plan, {
      mode: 'self-exec',
      args: ['daemon', '__run'],
      pushdPathChecked: null,
    });
  });
});

describe('isBunRuntime', () => {
  it('matches process.versions.bun in the running interpreter', () => {
    // Under `node --test` this is false; under a hypothetical `bun test` it
    // would be true. Either way it must agree with process.versions.bun.
    assert.equal(isBunRuntime(), Boolean(process.versions?.bun));
  });
});
