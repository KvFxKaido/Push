import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES,
  TOOL_CAPABILITIES,
  ROLE_CAPABILITIES,
  CAPABILITY_LABELS,
  roleHasCapability,
  roleCanUseTool,
  getToolCapabilities,
  isCapabilityMapped,
  formatCapabilities,
  CapabilityLedger,
  enforceRoleCapability,
  formatRoleCapabilityDenial,
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
// enforceRoleCapability — kernel-level gate
// ---------------------------------------------------------------------------

describe('enforceRoleCapability', () => {
  it('returns ROLE_REQUIRED when role is undefined / null / empty', () => {
    // Closes audit item #3: a binding that constructs a tool-execution
    // context without a role used to silently skip capability
    // enforcement. The helper now turns that into an explicit refusal
    // surfaced as a structured ROLE_REQUIRED error to the model.
    for (const empty of [undefined, null, '']) {
      const check = enforceRoleCapability(empty, 'sandbox_read_file');
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.type).toBe('ROLE_REQUIRED');
      expect(check.message).toContain('sandbox_read_file');
      expect(check.detail).toMatch(/role/i);
    }
  });

  it('returns ROLE_INVALID when role is a non-empty unrecognized value', () => {
    // Distinguished from ROLE_REQUIRED so the diagnostic is accurate:
    // the caller DID declare a value; it just wasn't a known AgentRole.
    // Typo-from-JS-caller is the common cause (Codex/Copilot review on
    // PR #546).
    const check = enforceRoleCapability('wat-is-this', 'sandbox_read_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.type).toBe('ROLE_INVALID');
    expect(check.message).toContain('"wat-is-this"');
    expect(check.detail).toContain('orchestrator');
  });

  it('reports a non-string invalid role with a useful sample', () => {
    const check = enforceRoleCapability({ not: 'a-role' }, 'sandbox_read_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.type).toBe('ROLE_INVALID');
    expect(check.message).toContain('[object Object]');
  });

  it('returns ROLE_CAPABILITY_DENIED when role lacks required capability', () => {
    const check = enforceRoleCapability('explorer', 'sandbox_write_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.type).toBe('ROLE_CAPABILITY_DENIED');
    expect(check.message).toContain('explorer');
    expect(check.message).toContain('sandbox_write_file');
    expect(check.detail).toContain('Required: repo:write');
    expect(check.detail).toContain('Granted:');
  });

  it('returns ok when role grants the tool', () => {
    expect(enforceRoleCapability('coder', 'sandbox_write_file')).toEqual({ ok: true });
    expect(enforceRoleCapability('explorer', 'sandbox_read_file')).toEqual({ ok: true });
    expect(enforceRoleCapability('orchestrator', 'web_search')).toEqual({ ok: true });
  });

  it('fail-open for unmapped tool names when role is present (forward-compat)', () => {
    // Mirrors `roleCanUseTool`'s documented fail-open semantics —
    // unmapped tools are admitted because future tools may not yet have
    // a capability entry. Only the ROLE_REQUIRED branch is fail-closed.
    expect(enforceRoleCapability('explorer', 'totally_unknown_tool')).toEqual({ ok: true });
  });

  it('ROLE_REQUIRED fires before the unmapped-tool fail-open', () => {
    // The two fail modes have priority: missing role denies even for
    // unmapped tool names. A forgetful binding cannot bypass via an
    // unknown name.
    const check = enforceRoleCapability(undefined, 'totally_unknown_tool');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.type).toBe('ROLE_REQUIRED');
  });

  it('denial detail reports the granted capability set for the role', () => {
    const check = enforceRoleCapability('auditor', 'sandbox_write_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    // Auditor only grants repo:read — that's what the detail should
    // surface so the model sees what it can do.
    expect(check.detail).toContain('Granted: repo:read');
  });
});

describe('formatRoleCapabilityDenial', () => {
  // The shared formatter is the single source of truth for denial body
  // text across the web runtime, CLI kernel, and Coder bindings. Before
  // its extraction, each surface stitched the body by hand and drifted
  // (Coder used a single space; CLI used `\n\n`). Pinning the shape
  // here flags any future regression that lets surfaces drift again.
  it('produces a stable [Tool Blocked] body for ROLE_REQUIRED', () => {
    const check = enforceRoleCapability(undefined, 'sandbox_read_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const body = formatRoleCapabilityDenial('sandbox_read_file', check);
    expect(body).toMatch(/^\[Tool Blocked — sandbox_read_file\] /);
    expect(body).toContain('\n\n');
  });

  it('produces a stable [Tool Blocked] body for ROLE_CAPABILITY_DENIED', () => {
    const check = enforceRoleCapability('explorer', 'sandbox_write_file');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const body = formatRoleCapabilityDenial('sandbox_write_file', check);
    expect(body).toContain('[Tool Blocked — sandbox_write_file]');
    expect(body).toContain('Required: repo:write');
    expect(body).toContain('Granted:');
  });
});

// ---------------------------------------------------------------------------
// CLI-native tool capability mappings (Gap 2)
// ---------------------------------------------------------------------------

describe('CLI-native tool capability mappings', () => {
  // Pin the exact capability assignments for the CLI-native tool names
  // added alongside the daemon-side `roleCanUseTool` swap. If any of
  // these entries drift without an accompanying review of
  // `makeDaemonExplorerToolExec`, this test breaks before production
  // behavior does.
  const expected: Record<string, readonly string[]> = {
    list_dir: ['repo:read'],
    read_symbols: ['repo:read'],
    read_symbol: ['repo:read'],
    git_status: ['repo:read'],
    git_diff: ['repo:read'],
    git_commit: ['git:commit'],
    lsp_diagnostics: ['repo:read'],
    save_memory: ['scratchpad'],
    write_file: ['repo:write'],
    edit_file: ['repo:write'],
    undo_edit: ['repo:write'],
    exec: ['sandbox:exec'],
    exec_start: ['sandbox:exec'],
    exec_poll: ['sandbox:exec'],
    exec_write: ['sandbox:exec'],
    exec_stop: ['sandbox:exec'],
    exec_list_sessions: ['sandbox:exec'],
  };

  for (const [tool, caps] of Object.entries(expected)) {
    it(`${tool} → ${caps.join(', ')}`, () => {
      expect(TOOL_CAPABILITIES[tool]).toEqual(caps);
    });
  }

  it('Explorer can use CLI-native read tools', () => {
    expect(roleCanUseTool('explorer', 'list_dir')).toBe(true);
    expect(roleCanUseTool('explorer', 'read_symbols')).toBe(true);
    expect(roleCanUseTool('explorer', 'read_symbol')).toBe(true);
    expect(roleCanUseTool('explorer', 'git_status')).toBe(true);
    expect(roleCanUseTool('explorer', 'git_diff')).toBe(true);
    expect(roleCanUseTool('explorer', 'lsp_diagnostics')).toBe(true);
  });

  it('Explorer cannot use CLI-native mutation tools', () => {
    expect(roleCanUseTool('explorer', 'write_file')).toBe(false);
    expect(roleCanUseTool('explorer', 'edit_file')).toBe(false);
    expect(roleCanUseTool('explorer', 'undo_edit')).toBe(false);
    expect(roleCanUseTool('explorer', 'git_commit')).toBe(false);
  });

  it('Explorer cannot use CLI-native exec family (intentional behavior change for exec_poll / exec_list_sessions)', () => {
    // Behavior change from READ_ONLY_TOOLS: `exec_poll` and
    // `exec_list_sessions` were Explorer-callable under the previous
    // allowlist. Under the shared table they require `sandbox:exec`,
    // which Explorer does not grant. Safe in practice: Explorer cannot
    // start the sessions it would be polling.
    expect(roleCanUseTool('explorer', 'exec')).toBe(false);
    expect(roleCanUseTool('explorer', 'exec_start')).toBe(false);
    expect(roleCanUseTool('explorer', 'exec_poll')).toBe(false);
    expect(roleCanUseTool('explorer', 'exec_write')).toBe(false);
    expect(roleCanUseTool('explorer', 'exec_stop')).toBe(false);
    expect(roleCanUseTool('explorer', 'exec_list_sessions')).toBe(false);
  });

  it('Explorer cannot use save_memory (scratchpad is not in Explorer grant)', () => {
    expect(roleCanUseTool('explorer', 'save_memory')).toBe(false);
  });

  it('Coder can use CLI-native mutation + exec + commit tools', () => {
    expect(roleCanUseTool('coder', 'write_file')).toBe(true);
    expect(roleCanUseTool('coder', 'edit_file')).toBe(true);
    expect(roleCanUseTool('coder', 'undo_edit')).toBe(true);
    expect(roleCanUseTool('coder', 'exec')).toBe(true);
    expect(roleCanUseTool('coder', 'exec_start')).toBe(true);
    expect(roleCanUseTool('coder', 'exec_poll')).toBe(true);
    expect(roleCanUseTool('coder', 'git_commit')).toBe(true);
  });

  it('save_memory is gated on scratchpad — orchestrator + coder allowed, explorer/reviewer/auditor blocked', () => {
    // Pin the scratchpad grant matrix so a future grant change that
    // silently opens or closes `save_memory` access breaks this test.
    expect(roleCanUseTool('orchestrator', 'save_memory')).toBe(true);
    expect(roleCanUseTool('coder', 'save_memory')).toBe(true);
    expect(roleCanUseTool('explorer', 'save_memory')).toBe(false);
    expect(roleCanUseTool('reviewer', 'save_memory')).toBe(false);
    expect(roleCanUseTool('auditor', 'save_memory')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prototype-key and unknown-tool safety (PR #331 review)
// ---------------------------------------------------------------------------

describe('getToolCapabilities — prototype-key safety', () => {
  // Regression pins for Codex P1 on PR #331: before the Object.hasOwn
  // guard, a model-supplied tool name matching an Object.prototype
  // key would resolve to the inherited prototype value. Some of those
  // keys have non-array prototype values (`__proto__`, `constructor`,
  // `hasOwnProperty`) so `roleCanUseTool`'s `.every` call would
  // throw. Others (`toString`, `valueOf`, `isPrototypeOf`) have
  // `.length === 0` functions that made `roleCanUseTool`'s fail-open
  // branch fire and silently return `true` — granting access to a
  // nonexistent tool.
  const prototypeKeys = [
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ];

  for (const key of prototypeKeys) {
    it(`getToolCapabilities("${key}") returns [] (not the inherited prototype value)`, () => {
      expect(getToolCapabilities(key)).toEqual([]);
    });

    it(`roleCanUseTool('explorer', "${key}") returns true (fail-open, but now at least doesn't crash or silently grant on a prototype-shaped value)`, () => {
      // Note: roleCanUseTool remains fail-open by documented design
      // — this pin is about "doesn't throw, treats prototype key
      // like any unknown tool" rather than about denying. The
      // daemon Explorer gate uses `isCapabilityMapped` to compose
      // fail-closed behavior on top; that's pinned separately in
      // cli/tests/daemon-role-capability.test.mjs.
      expect(() => roleCanUseTool('explorer', key)).not.toThrow();
      expect(roleCanUseTool('explorer', key)).toBe(true);
    });
  }
});

describe('isCapabilityMapped', () => {
  it('returns true for known tool names', () => {
    expect(isCapabilityMapped('sandbox_read_file')).toBe(true);
    expect(isCapabilityMapped('write_file')).toBe(true);
    expect(isCapabilityMapped('exec_poll')).toBe(true);
    expect(isCapabilityMapped('ask_user')).toBe(true);
  });

  it('returns false for unknown tool names', () => {
    expect(isCapabilityMapped('totally_unknown_tool')).toBe(false);
    expect(isCapabilityMapped('')).toBe(false);
    expect(isCapabilityMapped('sandbox_future_tool_not_yet_defined')).toBe(false);
  });

  it('returns false for prototype keys (defends against inherited-property lookup)', () => {
    expect(isCapabilityMapped('__proto__')).toBe(false);
    expect(isCapabilityMapped('constructor')).toBe(false);
    expect(isCapabilityMapped('toString')).toBe(false);
    expect(isCapabilityMapped('valueOf')).toBe(false);
    expect(isCapabilityMapped('hasOwnProperty')).toBe(false);
    expect(isCapabilityMapped('isPrototypeOf')).toBe(false);
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
