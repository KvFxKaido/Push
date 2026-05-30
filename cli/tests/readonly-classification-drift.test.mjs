import test from 'node:test';
import assert from 'node:assert/strict';

import { GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES, isReadOnlyToolCall } from '../tools.ts';
import { getToolPublicNames, isReadOnlyToolName } from '../../lib/tool-registry.ts';

// Drift detector for the one cross-surface seam in read-only tool
// classification (see CLAUDE.md "one source of truth per vocabulary").
//
// The web surface classifies a GitHub tool call as read-only by delegating
// straight to the shared registry (`isReadOnlyToolName`). The CLI, which
// surfaces GitHub tools under their PUBLIC names (`pr`, `repo_read`, …)
// alongside CLI-native tools, folds the read-only GitHub public names into its
// own parallelization bucket via `GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES`.
//
// Both must derive that set from the registry's `readOnly` flags, never a
// hand-maintained literal. These tests fail the moment the two surfaces could
// disagree about whether a given GitHub tool may run in parallel.

test('CLI read-only GitHub set matches the registry-derived public names', () => {
  const registryReadOnly = getToolPublicNames({ source: 'github', readOnly: true });

  assert.ok(registryReadOnly.length > 0, 'expected at least one read-only GitHub tool');

  const cli = [...GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES].sort();
  const registry = [...registryReadOnly].sort();

  assert.deepEqual(
    cli,
    registry,
    'CLI GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES drifted from getToolPublicNames({ source: "github", readOnly: true }) — derive it from the registry, do not hardcode',
  );
});

test('every read-only GitHub public name is registry read-only (no stale literals)', () => {
  for (const name of GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES) {
    assert.equal(
      isReadOnlyToolName(name),
      true,
      `CLI classifies "${name}" as read-only but the shared registry does not — surfaces would disagree about parallelization`,
    );
  }
});

test('CLI and registry agree on read-only for every GitHub public tool', () => {
  const allGitHubPublic = getToolPublicNames({ source: 'github' });

  assert.ok(allGitHubPublic.length > 0, 'expected GitHub public tool names');

  // The set must contain at least one write tool, otherwise the agreement
  // check below is vacuously true and would not catch a write tool being
  // mistakenly bucketed as read-only.
  const writeNames = allGitHubPublic.filter((name) => !isReadOnlyToolName(name));
  assert.ok(writeNames.length > 0, 'expected at least one write (side-effecting) GitHub tool');

  for (const tool of allGitHubPublic) {
    assert.equal(
      isReadOnlyToolCall({ tool }),
      isReadOnlyToolName(tool),
      `read-only classification for GitHub tool "${tool}" diverges between the CLI dispatch (isReadOnlyToolCall) and the shared registry (isReadOnlyToolName)`,
    );
  }
});
