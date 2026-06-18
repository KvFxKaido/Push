import { describe, expect, it } from 'vitest';
import { getToolPublicNames } from '@push/lib/tool-registry';
import { buildGitHubToolProtocol } from '@/lib/github-tool-protocol';
import { SANDBOX_TOOL_PROTOCOL } from '@/lib/sandbox-tool-detection';

/**
 * Read-tier precedence guard (web surface).
 *
 * Decision: on the web/cloud-sandbox surface the GitHub read tier is the
 * DEFAULT explore/search/read surface; the cloud sandbox read tools are
 * reserved for on-demand uncommitted working-tree reads (or when a GitHub
 * read fails). See docs/decisions/Agent Runtime Decisions.md §11.
 *
 * This pins the precedence into both protocol builders so a future prose
 * edit can't silently re-merge the two tiers back into "sandbox is the
 * default explore surface" without tripping CI. It does NOT cover the CLI
 * daemon, whose local-FS reads are the reliable default there.
 */
describe('read-tier precedence (GitHub default, sandbox on demand)', () => {
  const githubReadNames = getToolPublicNames({ source: 'github', readOnly: true });
  const sandboxReadNames = getToolPublicNames({ source: 'sandbox', readOnly: true });

  it('GitHub protocol marks the GitHub read tier as the default explore surface', () => {
    const protocol = buildGitHubToolProtocol();
    expect(protocol).toMatch(/READ TIER/);
    expect(protocol).toMatch(/DEFAULT way to explore/);
    // The reliability rationale (survives a slow/unavailable sandbox) is the
    // whole point of the pivot — keep it explicit.
    expect(protocol).toMatch(/even when the sandbox is slow or unavailable/);
  });

  it('sandbox protocol defers committed-code reads to the GitHub read tier', () => {
    expect(SANDBOX_TOOL_PROTOCOL).toMatch(/READ TIER/);
    // Cross-tier linkage: the sandbox protocol names the GitHub read tools as
    // the default, derived from the registry (not a stale literal).
    for (const name of githubReadNames) {
      expect(SANDBOX_TOOL_PROTOCOL).toContain(name);
    }
    // Sandbox reads are framed as the working-tree / on-demand exception.
    expect(SANDBOX_TOOL_PROTOCOL).toMatch(/WORKING TREE/);
  });

  it('keeps the sandbox read tools available (on demand, not removed)', () => {
    // Precedence is a default, not a ban — the sandbox read tools must still
    // be described so read-before-edit on uncommitted files works.
    expect(sandboxReadNames.length).toBeGreaterThan(0);
    for (const name of sandboxReadNames) {
      expect(SANDBOX_TOOL_PROTOCOL).toContain(name);
    }
  });
});
