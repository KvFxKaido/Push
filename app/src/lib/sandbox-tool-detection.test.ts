import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTED_SANDBOX_TOOLS,
  detectSandboxToolCall,
  getUnrecognizedSandboxToolName,
  validateSandboxToolCall,
} from './sandbox-tool-detection';

// ---------------------------------------------------------------------------
// validateSandboxToolCall — per-tool acceptance / rejection
// ---------------------------------------------------------------------------

describe('validateSandboxToolCall — sandbox_exec', () => {
  it('accepts a minimal exec call and normalises missing workdir', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_exec',
      args: { command: 'ls -la' },
    });
    expect(result).toEqual({
      tool: 'sandbox_exec',
      args: { command: 'ls -la', workdir: undefined },
    });
  });

  it('threads allowDirectGit through when true', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_exec',
      args: { command: 'git status', allowDirectGit: true },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_exec',
      args: { allowDirectGit: true },
    });
  });

  it('drops allowDirectGit when not literally true', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_exec',
      args: { command: 'git status', allowDirectGit: 'yes' },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_exec',
      args: { command: 'git status' },
    });
    expect((result as { args: Record<string, unknown> }).args.allowDirectGit).toBeUndefined();
  });

  it('rejects missing command', () => {
    expect(
      validateSandboxToolCall({ tool: 'sandbox_exec', args: { workdir: '/workspace' } }),
    ).toBeNull();
  });
});

describe('validateSandboxToolCall — sandbox_read_file', () => {
  it('accepts path + numeric start_line/end_line', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_file',
      args: { path: 'src/app.ts', start_line: 10, end_line: 20 },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_read_file',
      args: { start_line: 10, end_line: 20 },
    });
  });

  it('accepts numeric-string line bounds', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_file',
      args: { path: 'src/app.ts', start_line: '5', end_line: '8' },
    });
    expect(result).toMatchObject({
      args: { start_line: 5, end_line: 8 },
    });
  });

  it('rejects non-positive / non-integer line numbers', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_read_file',
        args: { path: 'src/app.ts', start_line: 0 },
      }),
    ).toBeNull();
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_read_file',
        args: { path: 'src/app.ts', start_line: 1.5 },
      }),
    ).toBeNull();
  });

  it('rejects reversed ranges (start > end)', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_read_file',
        args: { path: 'src/app.ts', start_line: 10, end_line: 5 },
      }),
    ).toBeNull();
  });
});

describe('validateSandboxToolCall — sandbox_search_replace', () => {
  it('rejects an empty search string to avoid matching everything', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_search_replace',
        args: { path: 'a.ts', search: '', replace: 'x' },
      }),
    ).toBeNull();
  });

  it('accepts a non-empty search/replace pair', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_search_replace',
      args: { path: 'a.ts', search: 'foo', replace: 'bar' },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_search_replace',
      args: { search: 'foo', replace: 'bar' },
    });
  });
});

describe('validateSandboxToolCall — sandbox_edit_range', () => {
  it('accepts a full line-range edit', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_edit_range',
      args: { path: 'a.ts', start_line: 1, end_line: 2, content: 'new' },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_edit_range',
      args: { start_line: 1, end_line: 2, content: 'new' },
    });
  });

  it('rejects edits missing start/end', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_edit_range',
        args: { path: 'a.ts', content: 'x' },
      }),
    ).toBeNull();
  });

  it('rejects edits with start > end', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_edit_range',
        args: { path: 'a.ts', start_line: 5, end_line: 2, content: 'x' },
      }),
    ).toBeNull();
  });
});

describe('validateSandboxToolCall — sandbox_apply_patchset', () => {
  it('accepts hashline-ops edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [{ path: 'a.ts', ops: [{ op: 'replace_line', ref: '1:abc1234', content: 'x' }] }],
      },
    });
    expect(result).toMatchObject({
      tool: 'sandbox_apply_patchset',
      args: { edits: [{ path: '/workspace/a.ts' }] },
    });
  });

  it('accepts a line-range patchset edit', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [{ path: '/workspace/a.ts', start_line: 1, end_line: 2, content: 'new' }],
      },
    });
    expect(result).toMatchObject({
      args: { edits: [{ path: '/workspace/a.ts', start_line: 1, end_line: 2, content: 'new' }] },
    });
  });

  it('rejects a patchset with no valid edits', () => {
    expect(
      validateSandboxToolCall({
        tool: 'sandbox_apply_patchset',
        args: { edits: [{ path: 'a.ts' }] }, // no ops, no content
      }),
    ).toBeNull();
  });

  it('normalises snake_case flags to camelCase', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        dry_run: true,
        rollback_on_failure: true,
        edits: [{ path: 'a.ts', start_line: 1, end_line: 1, content: 'x' }],
      },
    });
    expect(result).toMatchObject({
      args: { dryRun: true, rollbackOnFailure: true },
    });
  });

  it('clamps check timeoutMs into [1000, 30000] and preserves exitCode', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [{ path: 'a.ts', start_line: 1, end_line: 1, content: 'x' }],
        checks: [
          { command: 'npm test', exit_code: 0, timeout_ms: 500 },
          { command: 'npm run lint', exitCode: 1, timeoutMs: 60_000 },
          { command: '   ' }, // dropped: empty after trim
          { command: 'ok', timeoutMs: 5_000 },
        ],
      },
    });
    const checks = (result as { args: { checks: Array<Record<string, unknown>> } }).args.checks;
    expect(checks).toEqual([
      { command: 'npm test', exitCode: 0, timeoutMs: 1000 },
      { command: 'npm run lint', exitCode: 1, timeoutMs: 30_000 },
      { command: 'ok', exitCode: undefined, timeoutMs: 5_000 },
    ]);
  });
});

describe('validateSandboxToolCall — promote_to_github', () => {
  it('trims repo_name and drops falsy description/private', () => {
    const result = validateSandboxToolCall({
      tool: 'promote_to_github',
      args: { repo_name: '  my-repo  ' },
    });
    expect(result).toMatchObject({
      tool: 'promote_to_github',
      args: { repo_name: 'my-repo' },
    });
  });

  it('rejects an empty repo_name after trim', () => {
    expect(
      validateSandboxToolCall({
        tool: 'promote_to_github',
        args: { repo_name: '   ' },
      }),
    ).toBeNull();
  });
});

describe('validateSandboxToolCall — unknown / non-sandbox calls', () => {
  it('returns null for non-sandbox tools', () => {
    expect(
      validateSandboxToolCall({ tool: 'github_search_code', args: { query: 'foo' } }),
    ).toBeNull();
  });

  it('returns null for invalid input (non-object)', () => {
    expect(validateSandboxToolCall(null)).toBeNull();
    expect(validateSandboxToolCall('string')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSandboxToolCall — extraction from fenced-json prose
// ---------------------------------------------------------------------------

describe('detectSandboxToolCall', () => {
  it('extracts a valid call from a fenced JSON block', () => {
    const text = [
      'Sure, let me look.',
      '```json',
      '{"tool": "sandbox_exec", "args": {"command": "ls"}}',
      '```',
    ].join('\n');
    expect(detectSandboxToolCall(text)).toMatchObject({
      tool: 'sandbox_exec',
      args: { command: 'ls' },
    });
  });

  it('returns null when no sandbox tool block is present', () => {
    expect(detectSandboxToolCall('nothing to see here')).toBeNull();
  });

  it('returns null for a malformed sandbox tool call', () => {
    const text = '```json\n{"tool": "sandbox_read_file", "args": {}}\n```';
    expect(detectSandboxToolCall(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUnrecognizedSandboxToolName — flags sandbox_* typos
// ---------------------------------------------------------------------------

describe('getUnrecognizedSandboxToolName', () => {
  it('returns the typo name when sandbox_* is not in the implemented set', () => {
    const text = '```json\n{"tool": "sandbox_typo_tool", "args": {}}\n```';
    expect(getUnrecognizedSandboxToolName(text)).toBe('sandbox_typo_tool');
  });

  it('returns null for a recognized sandbox tool name', () => {
    const text = '```json\n{"tool": "sandbox_exec", "args": {"command": "x"}}\n```';
    expect(getUnrecognizedSandboxToolName(text)).toBeNull();
  });

  it('returns null for non-sandbox names', () => {
    expect(getUnrecognizedSandboxToolName('```json\n{"tool": "github_x"}\n```')).toBeNull();
  });
});

describe('IMPLEMENTED_SANDBOX_TOOLS', () => {
  it('contains core sandbox tools', () => {
    for (const name of [
      'sandbox_exec',
      'sandbox_read_file',
      'sandbox_write_file',
      'sandbox_edit_file',
      'sandbox_apply_patchset',
      'sandbox_verify_workspace',
    ]) {
      expect(IMPLEMENTED_SANDBOX_TOOLS.has(name)).toBe(true);
    }
  });
});

describe('LOCAL_PC_TOOL_PROTOCOL', () => {
  it('does not advertise /workspace as a default workdir or repo root', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // The cloud protocol advertises `/workspace` as the default workdir
    // (e.g. "default workdir: /workspace", "cloned to /workspace"). The
    // local-pc variant must avoid those AFFIRMATIVE uses — negative
    // mentions warning the model NOT to invent `/workspace` are fine
    // and intentional. Test the specific cloud-pattern phrasings.
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/default workdir:\s*\/workspace/i);
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/cloned to \/workspace/i);
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/\(default:\s*\/workspace\)/i);
  });

  it('explicitly disclaims the /workspace prior', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // Because the model has a strong cloud-sandbox training prior that
    // `/workspace` is the workspace root, an explicit disclaimer is
    // load-bearing — not just an omission.
    expect(LOCAL_PC_TOOL_PROTOCOL).toMatch(/no\s+`?\/workspace/i);
  });

  it('does not list cloud-only tools as part of the available tool surface', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // The original leak (PR #527 Copilot low-confidence #3) was
    // interpolating `${SANDBOX_MUTATING_TOOL_NAMES}`, which expands to
    // a comma list including the cloud-only tool public names
    // (commit, push, draft, promote, create_branch, switch_branch,
    // verify). The test must catch the *list-membership* pattern
    // specifically — natural-language mentions like "`git push`" or
    // "the user reviews diffs" are fine and shouldn't trip the guard.
    //
    // Pattern: tool name preceded by `, ` or `(` and followed by `,`,
    // `)`, or end-of-list. This matches the original leak shape but
    // not legitimate prose references.
    const commaListLeak = (name: string) => new RegExp(`(?:^|[,(])\\s*${name}\\s*(?:[,)]|$)`, 'm');
    for (const name of ['commit', 'push', 'draft', 'promote', 'create_branch', 'switch_branch']) {
      expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(commaListLeak(name));
    }
    // Affirmative protocol entries: `${PROMOTE_TOOL}(...)` would show up
    // as e.g. "- promote(repo_name, ...) — ..." in the cloud protocol.
    // Pin against the leading-dash signature form.
    for (const name of [
      'commit',
      'push',
      'draft',
      'promote',
      'create_branch',
      'switch_branch',
      'verify',
    ]) {
      expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(new RegExp(`^- ${name}\\(`, 'm'));
    }
    // Canonical-name leaks (the longer names, less ambiguous in prose).
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/sandbox_prepare_commit/);
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/sandbox_save_draft/);
    expect(LOCAL_PC_TOOL_PROTOCOL).not.toMatch(/promote_to_github/);
  });

  it('discourages Explorer/Coder delegation explicitly', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // Without this hint the model still reaches for Explorer from
    // training priors even when the tool isn't in its surface. Stated
    // explicitly so we're not relying on absence-of-instruction.
    expect(LOCAL_PC_TOOL_PROTOCOL).toMatch(/NO DELEGATION|do not delegate.*Explorer/i);
  });

  it('keeps the JSON fenced-call convention', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // Wire-format compat with the rest of Push: the tool-call parser
    // only looks for ```json ... ``` blocks.
    expect(LOCAL_PC_TOOL_PROTOCOL).toContain('```json');
  });

  it('lists the core sandbox_* tool public names that the daemon services', async () => {
    const { LOCAL_PC_TOOL_PROTOCOL } = await import('./sandbox-tool-detection');
    // Public tool names per the registry: exec / read / write / ls /
    // diff. These are what the model emits in fenced JSON calls.
    for (const tool of ['exec', 'read', 'write', 'ls']) {
      expect(LOCAL_PC_TOOL_PROTOCOL).toContain(tool);
    }
  });
});
