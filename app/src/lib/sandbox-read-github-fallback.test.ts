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

  it('strips the /workspace prefix to a repo-relative path (production paths are normalized)', () => {
    // validateSandboxToolCall runs args through normalizeSandboxPath, so real
    // calls arrive as /workspace/... — the GitHub contents API wants repo-relative.
    expect(
      mapSandboxReadToGitHubCall(
        { tool: 'sandbox_read_file', args: { path: '/workspace/src/app.ts' } },
        REPO,
        'main',
      ),
    ).toMatchObject({ tool: 'read_file', args: { path: 'src/app.ts' } });

    expect(
      mapSandboxReadToGitHubCall(
        { tool: 'sandbox_search', args: { query: 'x', path: '/workspace/app/src' } },
        REPO,
      ),
    ).toMatchObject({ tool: 'search_files', args: { query: 'x', path: 'app/src' } });
  });

  it('maps the /workspace root to no path filter (list/search scope the whole repo)', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_list_dir', args: { path: '/workspace' } }, REPO),
    ).toMatchObject({ tool: 'list_directory', args: { path: undefined } });
  });

  it('returns null when a read path resolves to the workspace root (not a file)', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_read_file', args: { path: '/workspace' } }, REPO),
    ).toBeNull();
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

  it('maps sandbox_find_references → search_files (symbol → query, scope → path)', () => {
    expect(
      mapSandboxReadToGitHubCall(
        {
          tool: 'sandbox_find_references',
          args: { symbol: 'buildPrompt', scope: '/workspace/app' },
        },
        REPO,
        'main',
      ),
    ).toEqual({
      tool: 'search_files',
      args: { repo: REPO, query: 'buildPrompt', path: 'app', branch: 'main' },
    });
  });

  it('maps find_references with the default /workspace scope to a repo-wide search', () => {
    expect(
      mapSandboxReadToGitHubCall(
        { tool: 'sandbox_find_references', args: { symbol: 'x', scope: '/workspace' } },
        REPO,
      ),
    ).toMatchObject({ tool: 'search_files', args: { query: 'x', path: undefined } });
  });

  it('returns null for read_symbols — its extractor has no GitHub-tier equivalent', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_read_symbols', args: { path: 'a.ts' } }, REPO),
    ).toBeNull();
  });

  it('returns null for find_references with no symbol', () => {
    expect(
      mapSandboxReadToGitHubCall({ tool: 'sandbox_find_references', args: {} }, REPO),
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
