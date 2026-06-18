import { describe, expect, it } from 'vitest';
import { mapSandboxReadToGitHubCall } from './sandbox-read-github-fallback';

describe('mapSandboxReadToGitHubCall', () => {
  const REPO = 'owner/repo';

  it('maps sandbox_read_file → read_file with repo + branch + line range', () => {
    const call = mapSandboxReadToGitHubCall(
      { tool: 'sandbox_read_file', args: { path: 'src/app.ts', start_line: 10, end_line: 40 } },
      REPO,
      'feature/x',
    );
    expect(call).toEqual({
      tool: 'read_file',
      args: { repo: REPO, path: 'src/app.ts', branch: 'feature/x', start_line: 10, end_line: 40 },
    });
  });

  it('maps sandbox_search → search_files, carrying an optional path filter', () => {
    expect(
      mapSandboxReadToGitHubCall(
        { tool: 'sandbox_search', args: { query: 'buildPrompt', path: 'app/src' } },
        REPO,
        'main',
      ),
    ).toEqual({
      tool: 'search_files',
      args: { repo: REPO, query: 'buildPrompt', path: 'app/src', branch: 'main' },
    });
  });

  it('maps sandbox_list_dir → list_directory (path optional)', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_list_dir', args: {} }, REPO, 'main'),
    ).toEqual({ tool: 'list_directory', args: { repo: REPO, path: undefined, branch: 'main' } });
  });

  it('resolves a public alias to its canonical tool before mapping', () => {
    // The detector usually canonicalizes, but the mapper must not depend on it.
    const call = mapSandboxReadToGitHubCall({ tool: 'read', args: { path: 'a.ts' } }, REPO);
    expect(call?.tool).toBe('read_file');
  });

  it('returns null for sandbox reads with no GitHub-tier equivalent', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_read_symbols', args: { path: 'a.ts' } }, REPO),
    ).toBeNull();
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_find_references', args: { symbol: 'x' } }, REPO),
    ).toBeNull();
  });

  it('returns null for non-read sandbox tools (no fallback for mutations/exec)', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_exec', args: { command: 'ls' } }, REPO),
    ).toBeNull();
    expect(
      mapSandboxReadToGitHubCall(
        { tool: 'sandbox_write_file', args: { path: 'a.ts', content: 'x' } },
        REPO,
      ),
    ).toBeNull();
  });

  it('returns null when no repo is available (nothing to query)', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_read_file', args: { path: 'a.ts' } }, ''),
    ).toBeNull();
  });

  it('returns null when a required arg is missing', () => {
    expect(mapSandboxReadToGitHubCall({ tool: 'sandbox_read_file', args: {} }, REPO)).toBeNull();
    expect(mapSandboxReadToGitHubCall({ tool: 'sandbox_search', args: {} }, REPO)).toBeNull();
  });

  it('omits branch when none is provided (GitHub reads the default ref)', () => {
    const call = mapSandboxReadToGitHubCall(
      { tool: 'sandbox_read_file', args: { path: 'a.ts' } },
      REPO,
    );
    expect(call).toEqual({
      tool: 'read_file',
      args: {
        repo: REPO,
        path: 'a.ts',
        branch: undefined,
        start_line: undefined,
        end_line: undefined,
      },
    });
  });
});
