/**
 * Dispatch-level integration tests for the `create_artifact` tool.
 *
 * These exercise the full path that the daemon takes when an
 * orchestrator emits a `create_artifact` tool call: validate via the
 * shared handler, resolve scope from the workspace, persist via the
 * CLI flat-JSON store, and return the structured result envelope.
 * The unit tests in `cli/tests/artifacts-store.test.mjs` and
 * `lib/artifacts/handler.test.ts` cover the lower layers; this file
 * is the seam where they meet.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeToolCall } from '../tools.ts';
import { CliFlatJsonArtifactStore } from '../artifacts-store.ts';

let tempArtifactsDir;
let tempWorkspace;
let previousArtifactsEnv;

before(async () => {
  tempArtifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-dispatch-art-'));
  tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-dispatch-ws-'));
  previousArtifactsEnv = process.env.PUSH_ARTIFACTS_DIR;
  process.env.PUSH_ARTIFACTS_DIR = tempArtifactsDir;
});

after(async () => {
  if (previousArtifactsEnv === undefined) delete process.env.PUSH_ARTIFACTS_DIR;
  else process.env.PUSH_ARTIFACTS_DIR = previousArtifactsEnv;
  await fs.rm(tempArtifactsDir, { recursive: true, force: true });
  await fs.rm(tempWorkspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(tempArtifactsDir, { recursive: true, force: true });
  await fs.mkdir(tempArtifactsDir, { recursive: true });
});

describe('executeToolCall(create_artifact)', () => {
  it('persists a valid mermaid artifact and returns a stable summary', async () => {
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: {
          kind: 'mermaid',
          title: 'Auth flow',
          source: 'graph TD; user-->login',
        },
      },
      tempWorkspace,
      { runId: 'run_dispatch_test' },
    );

    assert.equal(result.ok, true);
    assert.match(result.text, /^Artifact created: [\w-]+ — mermaid "Auth flow"\.$/);
    assert.equal(result.meta.kind, 'mermaid');
    assert.equal(typeof result.meta.artifactId, 'string');
    assert.equal(result.meta.scope.branch, null);
    // workspaceIdentity falls back to path.basename when no git; that's
    // the tempdir name we just created.
    assert.equal(result.meta.scope.repoFullName, path.basename(tempWorkspace));

    // Verify the record actually landed in the store under that scope.
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(result.meta.scope, result.meta.artifactId);
    assert.ok(loaded, 'artifact should be persisted');
    assert.equal(loaded.title, 'Auth flow');
    assert.equal(loaded.author.surface, 'cli');
    assert.equal(loaded.author.role, 'orchestrator');
    assert.equal(loaded.author.runId, 'run_dispatch_test');
  });

  it('maps validation failure to a structuredError envelope', async () => {
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: {
          kind: 'nonsense',
          title: 'x',
        },
      },
      tempWorkspace,
      { runId: 'run_dispatch_test' },
    );

    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'INVALID_KIND');
    assert.equal(result.structuredError.retryable, false);
    assert.match(result.text, /INVALID_KIND/);
  });

  it('rejects live-preview at validation and steers to the sibling tool', async () => {
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: { kind: 'live-preview', title: 'demo' },
      },
      tempWorkspace,
      { runId: 'run_dispatch_test' },
    );

    assert.equal(result.ok, false);
    assert.match(result.structuredError.message, /create_live_preview/);
  });

  it('omits runId from the author when options.runId is absent', async () => {
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: {
          kind: 'mermaid',
          title: 'No run',
          source: 'graph TD; A-->B',
        },
      },
      tempWorkspace,
      {}, // no runId
    );

    assert.equal(result.ok, true);
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(result.meta.scope, result.meta.artifactId);
    assert.equal(loaded.author.runId, undefined);
  });

  it('dispatches the public alias "artifact" the same as the canonical name', async () => {
    // The lib registry advertises the publicName "artifact" in
    // exampleJson, so the orchestrator will emit `{"tool": "artifact"}`
    // — the CLI executor must match it without going through
    // resolveToolName (the switch is canonical-name-shaped).
    const result = await executeToolCall(
      {
        tool: 'artifact',
        args: { kind: 'mermaid', title: 'Public name', source: 'graph TD; A-->B' },
      },
      tempWorkspace,
      { runId: 'run_alias' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.kind, 'mermaid');
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(result.meta.scope, result.meta.artifactId);
    assert.ok(loaded);
    assert.equal(loaded.author.role, 'orchestrator');
  });

  it('persists a Coder-role artifact with author.role="coder"', async () => {
    // Coder is now granted artifacts:write; daemon wrappers
    // (makeDaemonCoderToolExec) plumb role='coder' through. The
    // resulting record must carry the actual emitting role for
    // attribution — orchestrator default would mask which delegation
    // produced the artifact.
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: { kind: 'mermaid', title: 'Coder artifact', source: 'graph TD; A-->B' },
      },
      tempWorkspace,
      { runId: 'run_coder', role: 'coder' },
    );

    assert.equal(result.ok, true);
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(result.meta.scope, result.meta.artifactId);
    assert.equal(loaded.author.role, 'coder');
    assert.equal(loaded.author.runId, 'run_coder');
  });

  it('denies explorer/reviewer/auditor with CAPABILITY_DENIED (defense in depth)', async () => {
    // These roles never had artifacts:write and shouldn't get past
    // the dispatch role gate. Explorer in particular reaches
    // executeToolCall via makeDaemonExplorerToolExec, so the gate is
    // load-bearing for the read-only invariant.
    for (const role of ['explorer', 'reviewer', 'auditor']) {
      const result = await executeToolCall(
        {
          tool: 'create_artifact',
          args: { kind: 'mermaid', title: 'should fail', source: 'graph TD; A-->B' },
        },
        tempWorkspace,
        { runId: `run_${role}`, role },
      );

      assert.equal(result.ok, false, `role=${role} should be denied`);
      assert.equal(result.structuredError.code, 'CAPABILITY_DENIED');
      assert.match(result.structuredError.message, /artifacts:write/);
    }
  });

  it('treats an unknown role string as orchestrator-default (fail-safe)', async () => {
    // Garbage role values shouldn't break the dispatch — fall through
    // to the orchestrator default so a misconfigured caller still
    // produces a usable artifact rather than an opaque crash.
    const result = await executeToolCall(
      {
        tool: 'create_artifact',
        args: { kind: 'mermaid', title: 'Garbage role', source: 'graph TD; A-->B' },
      },
      tempWorkspace,
      { role: 'wat-is-this' },
    );

    assert.equal(result.ok, true);
    const store = new CliFlatJsonArtifactStore();
    const loaded = await store.get(result.meta.scope, result.meta.artifactId);
    assert.equal(loaded.author.role, 'orchestrator');
  });

  it('returns ARTIFACT_PERSIST_FAILED when the store throws', async () => {
    // Force the store to fail by pointing PUSH_ARTIFACTS_DIR at a
    // path whose parent is a regular file — mkdir will reject with
    // ENOTDIR. Restoring the env after the test keeps the suite
    // hermetic.
    const blockingFile = path.join(tempArtifactsDir, 'blocker');
    await fs.writeFile(blockingFile, 'blocker', 'utf8');
    const originalDir = process.env.PUSH_ARTIFACTS_DIR;
    process.env.PUSH_ARTIFACTS_DIR = path.join(blockingFile, 'cant-mkdir-here');

    try {
      const result = await executeToolCall(
        {
          tool: 'create_artifact',
          args: { kind: 'mermaid', title: 'fs failure', source: 'graph TD; A-->B' },
        },
        tempWorkspace,
        { runId: 'run_fs_fail' },
      );

      assert.equal(result.ok, false);
      assert.equal(result.structuredError.code, 'ARTIFACT_PERSIST_FAILED');
      assert.equal(result.structuredError.retryable, true);
    } finally {
      process.env.PUSH_ARTIFACTS_DIR = originalDir;
    }
  });
});
