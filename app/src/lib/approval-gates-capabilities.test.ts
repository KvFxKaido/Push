import { describe, it, expect } from 'vitest';
import { createDefaultApprovalGates, describeToolCapabilities, buildCapabilityApprovalPrompt } from './approval-gates';
import { CapabilityLedger } from './capabilities';
import type { ToolHookContext } from '@/types';

describe('Capability violation gate', () => {
  const gates = createDefaultApprovalGates();

  function makeContext(ledger?: CapabilityLedger): ToolHookContext {
    return {
      sandboxId: 'test-sandbox',
      allowedRepo: 'owner/repo',
      capabilityLedger: ledger,
    };
  }

  it('allows tools when no ledger is present', async () => {
    const result = await gates.evaluate('sandbox_write_file', {}, makeContext());
    expect(result).toBeNull();
  });

  it('allows tools within declared capabilities', async () => {
    const ledger = new CapabilityLedger(['repo:read', 'repo:write']);
    const result = await gates.evaluate('sandbox_write_file', {}, makeContext(ledger));
    expect(result).toBeNull();
  });

  it('blocks tools exceeding declared capabilities', async () => {
    const ledger = new CapabilityLedger(['repo:read']);
    const result = await gates.evaluate('sandbox_write_file', {}, makeContext(ledger));
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('blocked');
    expect(result!.category).toBe('capability_violation');
  });

  it('allows unknown tools (fail-open)', async () => {
    const ledger = new CapabilityLedger(['repo:read']);
    const result = await gates.evaluate('totally_unknown_tool', {}, makeContext(ledger));
    expect(result).toBeNull();
  });
});

describe('describeToolCapabilities', () => {
  it('returns human labels for known tools', () => {
    expect(describeToolCapabilities('sandbox_write_file')).toBe('edit files');
    expect(describeToolCapabilities('sandbox_push')).toBe('push to remote');
  });

  it('falls back to tool name for unknown tools', () => {
    expect(describeToolCapabilities('unknown_tool')).toBe('unknown_tool');
  });
});

describe('buildCapabilityApprovalPrompt', () => {
  it('builds a prompt for multiple tools', () => {
    const prompt = buildCapabilityApprovalPrompt([
      'sandbox_read_file',
      'sandbox_write_file',
      'sandbox_exec',
      'sandbox_prepare_commit',
    ]);
    expect(prompt).toContain('Allow this run to');
    expect(prompt).toContain('read code');
    expect(prompt).toContain('edit files');
    expect(prompt).toContain('execute commands');
    expect(prompt).toContain('create commits');
  });

  it('deduplicates capabilities across tools', () => {
    const prompt = buildCapabilityApprovalPrompt([
      'sandbox_read_file',
      'sandbox_search',
      'sandbox_list_dir',
    ]);
    // All three require repo:read — should only appear once
    expect(prompt).toBe('Allow this run to read code?');
  });
});
