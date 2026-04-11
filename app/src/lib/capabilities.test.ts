import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES,
  TOOL_CAPABILITIES,
  ROLE_CAPABILITIES,
  CAPABILITY_LABELS,
  roleHasCapability,
  roleCanUseTool,
  formatCapabilities,
  CapabilityLedger,
  type Capability,
} from './capabilities';
import { getAllToolSpecs } from './tool-registry';

// ---------------------------------------------------------------------------
// Static mapping completeness
// ---------------------------------------------------------------------------

describe('Capability mappings', () => {
  it('every tool in the registry has a capability mapping', () => {
    const specs = getAllToolSpecs();
    const unmapped: string[] = [];
    for (const spec of specs) {
      const caps = TOOL_CAPABILITIES[spec.canonicalName];
      if (!caps || caps.length === 0) {
        unmapped.push(spec.canonicalName);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it('every capability has a human-readable label', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(CAPABILITY_LABELS[cap]).toBeTruthy();
    }
  });

  it('TOOL_CAPABILITIES values only use known capabilities', () => {
    const known = new Set<string>(ALL_CAPABILITIES);
    for (const [tool, caps] of Object.entries(TOOL_CAPABILITIES)) {
      for (const cap of caps) {
        expect(known.has(cap), `${tool} uses unknown capability "${cap}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Role grants
// ---------------------------------------------------------------------------

describe('Role capability grants', () => {
  it('Explorer has only read-only capabilities', () => {
    const explorerCaps = ROLE_CAPABILITIES.explorer;
    const writeCaps: Capability[] = [
      'repo:write',
      'sandbox:exec',
      'git:commit',
      'git:push',
      'pr:write',
      'workflow:trigger',
      'delegate:coder',
      'delegate:explorer',
    ];
    for (const cap of writeCaps) {
      expect(explorerCaps.has(cap), `Explorer should not have ${cap}`).toBe(false);
    }
  });

  it('Coder has write capabilities', () => {
    expect(roleHasCapability('coder', 'repo:write')).toBe(true);
    expect(roleHasCapability('coder', 'sandbox:exec')).toBe(true);
    expect(roleHasCapability('coder', 'git:commit')).toBe(true);
    expect(roleHasCapability('coder', 'git:push')).toBe(true);
  });

  it('Orchestrator can delegate but not write code directly', () => {
    expect(roleHasCapability('orchestrator', 'delegate:coder')).toBe(true);
    expect(roleHasCapability('orchestrator', 'delegate:explorer')).toBe(true);
    expect(roleHasCapability('orchestrator', 'repo:write')).toBe(false);
    expect(roleHasCapability('orchestrator', 'sandbox:exec')).toBe(false);
  });

  it('Auditor has minimal capabilities', () => {
    const auditorCaps = ROLE_CAPABILITIES.auditor;
    expect(auditorCaps.size).toBe(1);
    expect(auditorCaps.has('repo:read')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// roleCanUseTool
// ---------------------------------------------------------------------------

describe('roleCanUseTool', () => {
  it('Explorer can use read-only sandbox tools', () => {
    expect(roleCanUseTool('explorer', 'sandbox_read_file')).toBe(true);
    expect(roleCanUseTool('explorer', 'sandbox_search')).toBe(true);
    expect(roleCanUseTool('explorer', 'web_search')).toBe(true);
  });

  it('Explorer cannot use write tools', () => {
    expect(roleCanUseTool('explorer', 'sandbox_write_file')).toBe(false);
    expect(roleCanUseTool('explorer', 'sandbox_exec')).toBe(false);
    expect(roleCanUseTool('explorer', 'sandbox_prepare_commit')).toBe(false);
  });

  it('Coder can use all sandbox tools', () => {
    expect(roleCanUseTool('coder', 'sandbox_write_file')).toBe(true);
    expect(roleCanUseTool('coder', 'sandbox_exec')).toBe(true);
    expect(roleCanUseTool('coder', 'sandbox_prepare_commit')).toBe(true);
    expect(roleCanUseTool('coder', 'sandbox_push')).toBe(true);
  });

  it('returns true for unknown tools (fail-open)', () => {
    expect(roleCanUseTool('coder', 'totally_unknown_tool')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CapabilityLedger
// ---------------------------------------------------------------------------

describe('CapabilityLedger', () => {
  it('records tool usage and produces accurate snapshots', () => {
    const ledger = new CapabilityLedger(['repo:read', 'repo:write']);

    ledger.recordToolUse('sandbox_read_file');
    ledger.recordToolUse('sandbox_write_file');

    const snap = ledger.snapshot();
    expect(snap.declared).toContain('repo:read');
    expect(snap.declared).toContain('repo:write');
    expect(snap.used).toContain('repo:read');
    expect(snap.used).toContain('repo:write');
    expect(snap.unused).toEqual([]);
    expect(snap.exceeded).toEqual([]);
  });

  it('detects unused capabilities', () => {
    const ledger = new CapabilityLedger(['repo:read', 'repo:write', 'git:commit']);
    ledger.recordToolUse('sandbox_read_file');

    const snap = ledger.snapshot();
    expect(snap.unused).toContain('repo:write');
    expect(snap.unused).toContain('git:commit');
    expect(snap.unused).not.toContain('repo:read');
  });

  it('detects exceeded capabilities', () => {
    const ledger = new CapabilityLedger(['repo:read']);
    ledger.recordToolUse('sandbox_write_file'); // requires repo:write

    const snap = ledger.snapshot();
    expect(snap.exceeded).toContain('repo:write');
  });

  it('isToolAllowed checks against declared set', () => {
    const ledger = new CapabilityLedger(['repo:read']);
    expect(ledger.isToolAllowed('sandbox_read_file')).toBe(true);
    expect(ledger.isToolAllowed('sandbox_write_file')).toBe(false);
  });

  it('getMissingCapabilities returns the gap', () => {
    const ledger = new CapabilityLedger(['repo:read']);
    expect(ledger.getMissingCapabilities('sandbox_push')).toEqual(['git:push']);
    expect(ledger.getMissingCapabilities('sandbox_read_file')).toEqual([]);
  });

  it('accepts a Set as constructor input', () => {
    const ledger = new CapabilityLedger(new Set<Capability>(['repo:read']));
    expect(ledger.isToolAllowed('sandbox_read_file')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCapabilities
// ---------------------------------------------------------------------------

describe('formatCapabilities', () => {
  it('formats a single capability', () => {
    expect(formatCapabilities(new Set<Capability>(['repo:read']))).toBe('read code');
  });

  it('formats two capabilities with "and"', () => {
    const result = formatCapabilities(new Set<Capability>(['repo:read', 'repo:write']));
    expect(result).toBe('read code and edit files');
  });

  it('formats three+ with Oxford comma', () => {
    const result = formatCapabilities(new Set<Capability>(['repo:read', 'repo:write', 'git:push']));
    expect(result).toBe('read code, edit files, and push to remote');
  });

  it('returns fallback for empty set', () => {
    expect(formatCapabilities(new Set())).toBe('no special permissions');
  });
});
