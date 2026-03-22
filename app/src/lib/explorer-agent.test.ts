import { describe, expect, it } from 'vitest';

import { evaluatePreHooks } from './tool-hooks';
import { buildExplorerSystemPrompt, createExplorerToolHooks } from './explorer-agent';

const TEST_CONTEXT = {
  sandboxId: 'sb-123',
  allowedRepo: 'KvFxKaido/Push',
  activeProvider: 'openrouter',
  activeModel: 'anthropic/claude-sonnet-4.6:nitro',
} as const;

describe('createExplorerToolHooks', () => {
  it('allows read-only inspection tools', async () => {
    const hooks = createExplorerToolHooks();

    const result = await evaluatePreHooks(
      hooks,
      'sandbox_read_file',
      { path: '/workspace/app/src/lib/tool-dispatch.ts' },
      TEST_CONTEXT,
    );

    expect(result).toBeNull();
  });

  it('blocks mutating tools with a read-only explanation', async () => {
    const hooks = createExplorerToolHooks();

    const result = await evaluatePreHooks(
      hooks,
      'sandbox_exec',
      { command: 'npm test' },
      TEST_CONTEXT,
    );

    expect(result?.decision).toBe('deny');
    expect(result?.reason).toContain('Explorer is read-only');
    expect(result?.reason).toContain('sandbox_read_file');
  });

  it('blocks secondary delegation tools', async () => {
    const hooks = createExplorerToolHooks();

    const result = await evaluatePreHooks(
      hooks,
      'delegate_coder',
      { task: 'make changes' },
      TEST_CONTEXT,
    );

    expect(result?.decision).toBe('deny');
    expect(result?.reason).toContain('delegate_coder');
  });
});

describe('buildExplorerSystemPrompt', () => {
  it('keeps Explorer focused on read-only tools', () => {
    const prompt = buildExplorerSystemPrompt();

    expect(prompt).toContain('repo_read');
    expect(prompt).toContain('read');
    expect(prompt).toContain('web');
    expect(prompt).toContain('You may use only these read-only tools');
    expect(prompt).toContain('Default workflow');
    expect(prompt).toContain('Recommended next step');
    expect(prompt).toContain('name the next actor');
    expect(prompt).toContain('Do NOT call coder, explorer');
    expect(prompt).not.toContain('{"tool": "exec"');


  it('includes stronger discovery guidance and bounded stop conditions', () => {
    const prompt = buildExplorerSystemPrompt();

    expect(prompt).toContain('discovery-shaped');
    expect(prompt).toContain('rank the most relevant files first');
    expect(prompt).toContain('relevant files, symbols, and control points');
    expect(prompt).toContain('broad but bounded investigation');
  });
    expect(prompt).not.toContain('{"tool": "coder"');
  });
});
