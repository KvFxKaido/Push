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
});
