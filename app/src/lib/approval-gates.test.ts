import { describe, expect, it } from 'vitest';
import { ApprovalGateRegistry, createDefaultApprovalGates } from './approval-gates';
import type { ApprovalMode } from './approval-mode';
import type { ApprovalGateBlockedResult, ApprovalGateDecision, ToolHookContext } from '@/types';

function makeContext(): ToolHookContext {
  return { sandboxId: 'sbx', allowedRepo: 'owner/repo' };
}

function gatesForMode(mode: ApprovalMode) {
  return createDefaultApprovalGates({ modeProvider: () => mode });
}

async function evalGate(
  mode: ApprovalMode,
  tool: string,
  args: Record<string, unknown>,
): Promise<ApprovalGateBlockedResult | null> {
  return gatesForMode(mode).evaluate(tool, args, makeContext());
}

// ---------------------------------------------------------------------------
// ApprovalGateRegistry — generic behavior
// ---------------------------------------------------------------------------

describe('ApprovalGateRegistry', () => {
  it('returns null when no rules are registered', async () => {
    const registry = new ApprovalGateRegistry();
    const result = await registry.evaluate('anything', {}, makeContext());
    expect(result).toBeNull();
  });

  it('matches string matchers exactly', async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'r1',
      label: 'l',
      category: 'destructive_sandbox',
      matcher: 'tool_a',
      evaluate: () => 'blocked',
      blockedReason: 'nope',
      recoveryPath: 'rec',
    });
    expect(await registry.evaluate('tool_a', {}, makeContext())).not.toBeNull();
    expect(await registry.evaluate('tool_b', {}, makeContext())).toBeNull();
  });

  it('supports pipe-delimited string matchers', async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'multi',
      label: 'l',
      category: 'remote_side_effect',
      matcher: 'tool_a|tool_b|tool_c',
      evaluate: () => 'ask_user',
      blockedReason: 'reason',
      recoveryPath: 'rec',
    });
    expect(await registry.evaluate('tool_a', {}, makeContext())).not.toBeNull();
    expect(await registry.evaluate('tool_c', {}, makeContext())).not.toBeNull();
    expect(await registry.evaluate('tool_d', {}, makeContext())).toBeNull();
  });

  it('supports regex matchers', async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'regex',
      label: 'l',
      category: 'capability_violation',
      matcher: /^sandbox_/,
      evaluate: () => 'blocked',
      blockedReason: 'reason',
      recoveryPath: 'rec',
    });
    expect(await registry.evaluate('sandbox_exec', {}, makeContext())).not.toBeNull();
    expect(await registry.evaluate('other_tool', {}, makeContext())).toBeNull();
  });

  it('short-circuits on the first non-allowed rule', async () => {
    const registry = new ApprovalGateRegistry();
    let secondRuleEvaluated = false;
    registry.register({
      id: 'first',
      label: 'first',
      category: 'destructive_sandbox',
      matcher: 'tool_x',
      evaluate: () => 'blocked',
      blockedReason: 'first-reason',
      recoveryPath: 'first-rec',
    });
    registry.register({
      id: 'second',
      label: 'second',
      category: 'remote_side_effect',
      matcher: 'tool_x',
      evaluate: () => {
        secondRuleEvaluated = true;
        return 'blocked';
      },
      blockedReason: 'second-reason',
      recoveryPath: 'second-rec',
    });
    const result = await registry.evaluate('tool_x', {}, makeContext());
    expect(result?.gateId).toBe('first');
    expect(secondRuleEvaluated).toBe(false);
  });

  it('continues past rules that return "allowed"', async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'pass',
      label: 'pass',
      category: 'destructive_sandbox',
      matcher: 'tool_x',
      evaluate: () => 'allowed',
      blockedReason: 'nope',
      recoveryPath: 'nope',
    });
    registry.register({
      id: 'stop',
      label: 'stop',
      category: 'remote_side_effect',
      matcher: 'tool_x',
      evaluate: () => 'ask_user',
      blockedReason: 'ask',
      recoveryPath: 'rec',
    });
    const result = await registry.evaluate('tool_x', {}, makeContext());
    expect(result?.gateId).toBe('stop');
    expect(result?.decision).toBe('ask_user');
  });

  it('awaits async rule evaluators', async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'async',
      label: 'async',
      category: 'destructive_sandbox',
      matcher: 'tool_x',
      evaluate: async (): Promise<ApprovalGateDecision> => {
        await Promise.resolve();
        return 'blocked';
      },
      blockedReason: 'async-reason',
      recoveryPath: 'rec',
    });
    const result = await registry.evaluate('tool_x', {}, makeContext());
    expect(result?.decision).toBe('blocked');
  });

  it("propagates the rule's reason and recoveryPath in the result", async () => {
    const registry = new ApprovalGateRegistry();
    registry.register({
      id: 'r1',
      label: 'l',
      category: 'git_override',
      matcher: 'tool_x',
      evaluate: () => 'ask_user',
      blockedReason: 'because-reasons',
      recoveryPath: 'do-this-instead',
    });
    const result = await registry.evaluate('tool_x', {}, makeContext());
    expect(result).toEqual({
      gateId: 'r1',
      category: 'git_override',
      decision: 'ask_user',
      reason: 'because-reasons',
      recoveryPath: 'do-this-instead',
    });
  });
});

// ---------------------------------------------------------------------------
// destructive-sandbox-exec gate
// ---------------------------------------------------------------------------

describe('destructive-sandbox-exec gate', () => {
  it('allows non-destructive commands in supervised mode', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', { command: 'ls -la' });
    expect(result).toBeNull();
  });

  it.each([
    ['rm -rf node_modules'],
    ['rm -fr dist'],
    ['rm --recursive --force build'],
    ['git clean -fdx'],
    ['git reset --hard HEAD~1'],
    ['git checkout -- .'],
    ['git restore .'],
    ['git restore . && echo done'],
    ['find . -name "*.log" -delete'],
    ['find /tmp -delete'],
    ['find /tmp -delete -print'],
    ['truncate -s 0 app.log'],
    ['cat secret > /dev/null'],
  ])('asks for approval in supervised mode for destructive command: %s', async (command) => {
    const result = await evalGate('supervised', 'sandbox_exec', { command });
    expect(result?.decision).toBe('ask_user');
    expect(result?.category).toBe('destructive_sandbox');
    expect(result?.gateId).toBe('destructive-sandbox-exec');
  });

  it('allows destructive commands in autonomous mode', async () => {
    const result = await evalGate('autonomous', 'sandbox_exec', { command: 'rm -rf dist' });
    expect(result).toBeNull();
  });

  it('allows destructive commands in full-auto mode', async () => {
    const result = await evalGate('full-auto', 'sandbox_exec', { command: 'git reset --hard' });
    expect(result).toBeNull();
  });

  it('does not match non-destructive rm variants', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', { command: 'rm file.txt' });
    expect(result).toBeNull();
  });

  it.each([
    // `git restore ./path` restores a single file — not the bare-dot form.
    ['git restore ./file.txt'],
    ['git restore src/file.ts'],
    // Substring-looking inputs must still be word-bounded.
    ['mygit restore .'],
    ['gitx restore .'],
  ])('does not match non-destructive git-restore variants: %s', async (command) => {
    const result = await evalGate('supervised', 'sandbox_exec', { command });
    expect(result).toBeNull();
  });

  it.each([
    // `findme` isn't `find`; should not trigger.
    ['findme-delete-x'],
    // `-delete` flag is specific to GNU find — unrelated contexts must not trigger.
    ['echo find-delete-not-a-flag'],
  ])('does not match non-destructive find-delete variants: %s', async (command) => {
    const result = await evalGate('supervised', 'sandbox_exec', { command });
    expect(result).toBeNull();
  });

  it('treats non-string commands as non-destructive', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', { command: 12345 });
    expect(result).toBeNull();
  });

  it('ignores tools other than sandbox_exec', async () => {
    const result = await evalGate('supervised', 'sandbox_write_file', {
      command: 'rm -rf /',
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// git-direct-override gate
// ---------------------------------------------------------------------------

describe('git-direct-override gate', () => {
  it('allows sandbox_exec without allowDirectGit', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', { command: 'git status' });
    expect(result).toBeNull();
  });

  it('asks for approval in supervised mode when allowDirectGit is true', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', {
      command: 'git push',
      allowDirectGit: true,
    });
    expect(result?.decision).toBe('ask_user');
    expect(result?.gateId).toBe('git-direct-override');
    expect(result?.category).toBe('git_override');
  });

  it('allows allowDirectGit in autonomous mode', async () => {
    const result = await evalGate('autonomous', 'sandbox_exec', {
      command: 'git push',
      allowDirectGit: true,
    });
    expect(result).toBeNull();
  });

  it('allows allowDirectGit in full-auto mode', async () => {
    const result = await evalGate('full-auto', 'sandbox_exec', {
      command: 'git push',
      allowDirectGit: true,
    });
    expect(result).toBeNull();
  });

  it('ignores truthy-but-not-true allowDirectGit (strict === true check)', async () => {
    const result = await evalGate('supervised', 'sandbox_exec', {
      command: 'git push',
      allowDirectGit: 'true',
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remote-side-effect gate
// ---------------------------------------------------------------------------

describe('remote-side-effect gate', () => {
  const remoteTools = ['sandbox_push', 'pr_create', 'pr_merge', 'branch_delete', 'workflow_run'];

  it.each(remoteTools)('asks for approval in supervised mode for %s', async (tool) => {
    const result = await evalGate('supervised', tool, {});
    expect(result?.decision).toBe('ask_user');
    expect(result?.gateId).toBe('remote-side-effect');
    expect(result?.category).toBe('remote_side_effect');
  });

  it.each(remoteTools)('allows %s in autonomous mode', async (tool) => {
    const result = await evalGate('autonomous', tool, {});
    expect(result).toBeNull();
  });

  it.each(remoteTools)('allows %s in full-auto mode', async (tool) => {
    const result = await evalGate('full-auto', tool, {});
    expect(result).toBeNull();
  });

  it('does not match unrelated tools', async () => {
    const result = await evalGate('supervised', 'sandbox_read_file', {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mode provider defaulting
// ---------------------------------------------------------------------------

describe('createDefaultApprovalGates modeProvider option', () => {
  it('reads the mode lazily (per-evaluation)', async () => {
    let mode: ApprovalMode = 'supervised';
    const gates = createDefaultApprovalGates({ modeProvider: () => mode });

    const first = await gates.evaluate('sandbox_push', {}, makeContext());
    expect(first?.decision).toBe('ask_user');

    mode = 'autonomous';
    const second = await gates.evaluate('sandbox_push', {}, makeContext());
    expect(second).toBeNull();
  });
});
