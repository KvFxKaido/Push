import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES,
  TOOL_CAPABILITIES,
  ROLE_CAPABILITIES,
  CAPABILITY_LABELS,
  roleHasCapability,
  roleCanUseTool,
  getToolCapabilities,
  getEffectiveCapabilities,
  isCapabilityMapped,
  formatCapabilities,
  CapabilityLedger,
  enforceRoleCapability,
  formatRoleCapabilityDenial,
  workspaceModeToExecutionMode,
  type Capability,
  type ExecutionMode,
} from './capabilities';
import { getExecutionMode } from '@push/lib/tool-execution-runtime';
import type { WorkspaceMode } from '@/types';
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

  it('Orchestrator is the single capable lead: edits, runs commands, and ships directly', () => {
    // Coder Delegation Collapse (2026-06-04): the lead has the full sandbox +
    // git grant and runs the work itself. delegate:coder is retained (CLI/daemon
    // task-graph + headless), but the lead no longer routes ordinary work to it.
    expect(roleHasCapability('orchestrator', 'delegate:coder')).toBe(true);
    expect(roleHasCapability('orchestrator', 'delegate:explorer')).toBe(true);
    expect(roleHasCapability('orchestrator', 'repo:write')).toBe(true);
    expect(roleHasCapability('orchestrator', 'git:commit')).toBe(true);
    expect(roleHasCapability('orchestrator', 'git:push')).toBe(true);
    expect(roleHasCapability('orchestrator', 'sandbox:exec')).toBe(true);
    expect(roleHasCapability('orchestrator', 'sandbox:test')).toBe(true);
    // NOT sandbox:download in the base grant — it also authorizes
    // promote_to_github (create-repo + push), which stays a gated, daemon-only op.
    expect(roleHasCapability('orchestrator', 'sandbox:download')).toBe(false);
  });

  it('cloud lead cannot promote_to_github (download grant stays daemon-only)', () => {
    // Codex/cubic P1 on the collapse: sandbox:download also authorizes
    // promote_to_github (create-repo + push). Keeping download out of the cloud
    // base grant keeps promote unavailable to the cloud lead.
    expect(roleCanUseTool('orchestrator', 'promote_to_github', 'cloud')).toBe(false);
    expect(roleCanUseTool('orchestrator', 'sandbox_download', 'cloud')).toBe(false);
  });

  it('Orchestrator (cloud) can drive PRs and workflow dispatch when the user asks', () => {
    // The UI owns the PR flow by default, but the model has the grant to take
    // over when explicitly asked. Approval gates handle per-call consent.
    expect(roleHasCapability('orchestrator', 'pr:write')).toBe(true);
    expect(roleHasCapability('orchestrator', 'workflow:trigger')).toBe(true);
    expect(roleCanUseTool('orchestrator', 'create_pr')).toBe(true);
    expect(roleCanUseTool('orchestrator', 'merge_pr')).toBe(true);
    expect(roleCanUseTool('orchestrator', 'delete_branch')).toBe(true);
    expect(roleCanUseTool('orchestrator', 'trigger_workflow')).toBe(true);
  });

  it('Auditor has minimal capabilities', () => {
    const auditorCaps = ROLE_CAPABILITIES.auditor;
    // repo:read for diff inspection + memory:read to recall prior decisions/verifications.
    expect(auditorCaps.size).toBe(2);
    expect(auditorCaps.has('repo:read')).toBe(true);
    expect(auditorCaps.has('memory:read')).toBe(true);
  });

  // Advertising-matches-executor drift guard (LCM): every role whose prompt
  // advertises the memory tools (orchestrator, explorer, coder, reviewer — the
  // canonical role key for the Deep-Reviewer) must be able to EXECUTE them, or
  // we ship advertised-but-denied tools. If a
  // future change strips `memory:read` from a role, this fails before the model
  // hits a confusing ROLE_CAPABILITY_DENIED at runtime.
  it('every memory-advertised role can execute memory_grep / memory_expand', () => {
    for (const role of ['orchestrator', 'explorer', 'coder', 'reviewer'] as const) {
      expect(roleCanUseTool(role, 'memory_grep')).toBe(true);
      expect(roleCanUseTool(role, 'memory_expand')).toBe(true);
    }
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
    expect(roleCanUseTool('explorer', 'sandbox_commit')).toBe(false);
  });

  it('Coder can use all sandbox tools', () => {
    expect(roleCanUseTool('coder', 'sandbox_write_file')).toBe(true);
    expect(roleCanUseTool('coder', 'sandbox_exec')).toBe(true);
    expect(roleCanUseTool('coder', 'sandbox_commit')).toBe(true);
    expect(roleCanUseTool('coder', 'prepare_push')).toBe(true);
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
// Execution mode — cloud orchestrator vs local-daemon orchestrator
// ---------------------------------------------------------------------------

describe('ExecutionMode — orchestrator capability widening for local-daemon', () => {
  // The named-mode contract is the policy input. We pin both halves:
  // cloud (today's behavior) and local-daemon (orchestrator picks up the
  // daemon extras). The runtime edge derives the mode from
  // `localDaemonBinding` via `getExecutionMode`; the capability layer
  // never sees the binding directly.

  describe('cloud mode (default) gives orchestrator the full edit + exec lane', () => {
    it('orchestrator can write/edit/patch, commit/push, AND exec in cloud mode', () => {
      // Coder Delegation Collapse: the lead does the work itself.
      expect(roleCanUseTool('orchestrator', 'sandbox_write_file', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_edit_file', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_edit_range', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_search_replace', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_apply_patchset', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_commit', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'prepare_push', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_push', 'cloud')).toBe(true);
      // Exec lane is now the lead's — no more delegation just to run something.
      expect(roleCanUseTool('orchestrator', 'sandbox_exec', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_run_tests', 'cloud')).toBe(true);
    });

    it('omitting the mode argument behaves like cloud (back-compat)', () => {
      expect(roleCanUseTool('orchestrator', 'sandbox_exec')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_write_file')).toBe(true);
      expect(roleHasCapability('orchestrator', 'sandbox:exec')).toBe(true);
      expect(roleHasCapability('orchestrator', 'repo:write')).toBe(true);
    });

    it('orchestrator keeps its base grant in cloud mode', () => {
      expect(roleCanUseTool('orchestrator', 'sandbox_read_file', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'delegate_coder', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'delegate_explorer', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'web_search', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'ask_user', 'cloud')).toBe(true);
    });

    it('orchestrator can drive PR mutations and workflow dispatch in cloud mode', () => {
      expect(roleCanUseTool('orchestrator', 'create_pr', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'merge_pr', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'delete_branch', 'cloud')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'trigger_workflow', 'cloud')).toBe(true);
    });
  });

  describe('local-daemon mode widens orchestrator to wield sandbox tools directly', () => {
    it('orchestrator gains sandbox:exec, repo:write, sandbox:test, sandbox:download', () => {
      expect(roleHasCapability('orchestrator', 'sandbox:exec', 'local-daemon')).toBe(true);
      expect(roleHasCapability('orchestrator', 'repo:write', 'local-daemon')).toBe(true);
      expect(roleHasCapability('orchestrator', 'sandbox:test', 'local-daemon')).toBe(true);
      expect(roleHasCapability('orchestrator', 'sandbox:download', 'local-daemon')).toBe(true);
    });

    it('orchestrator can use sandbox_exec and write/edit/patch tools', () => {
      expect(roleCanUseTool('orchestrator', 'sandbox_exec', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_write_file', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_edit_file', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_edit_range', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_search_replace', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_apply_patchset', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_run_tests', 'local-daemon')).toBe(true);
    });

    it('orchestrator gains LOCAL git ops (commit/branch) but not remote-bound ones', () => {
      // local-daemon operates on a real local working tree (CLI, or web
      // Remote paired to a real machine), so local git ops are
      // grantable without a remote. Only genuinely remote-bound ops stay
      // stripped. This is what lets a non-delegated CLI orchestrator use the
      // git_commit / git_create_branch / git_switch_branch tools that
      // TOOL_PROTOCOL advertises (PR #700 / Codex P2).
      expect(roleHasCapability('orchestrator', 'git:commit', 'local-daemon')).toBe(true);
      expect(roleHasCapability('orchestrator', 'git:branch', 'local-daemon')).toBe(true);
      expect(roleCanUseTool('orchestrator', 'sandbox_commit', 'local-daemon')).toBe(true);
      // prepare_push is git:push — remote-bound, so stripped in local-daemon.
      expect(roleCanUseTool('orchestrator', 'prepare_push', 'local-daemon')).toBe(false);

      // Remote-bound ops remain stripped (no remote in a paired session).
      expect(roleHasCapability('orchestrator', 'git:push', 'local-daemon')).toBe(false);
      expect(roleHasCapability('orchestrator', 'git:draft', 'local-daemon')).toBe(false);
      expect(roleHasCapability('orchestrator', 'pr:write', 'local-daemon')).toBe(false);
      expect(roleHasCapability('orchestrator', 'workflow:trigger', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('orchestrator', 'sandbox_push', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('orchestrator', 'create_pr', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('orchestrator', 'merge_pr', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('orchestrator', 'delete_branch', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('orchestrator', 'trigger_workflow', 'local-daemon')).toBe(false);
    });
  });

  describe('other roles are mode-independent', () => {
    it('explorer stays read-only in both modes', () => {
      for (const mode of ['cloud', 'local-daemon'] as const) {
        expect(roleCanUseTool('explorer', 'sandbox_exec', mode)).toBe(false);
        expect(roleCanUseTool('explorer', 'sandbox_write_file', mode)).toBe(false);
        expect(roleCanUseTool('explorer', 'sandbox_read_file', mode)).toBe(true);
      }
    });

    it('coder keeps sandbox/git caps in both modes but loses remote-only caps on local-daemon', () => {
      // Sandbox + local-git caps are mode-independent for coder.
      for (const mode of ['cloud', 'local-daemon'] as const) {
        expect(roleCanUseTool('coder', 'sandbox_exec', mode)).toBe(true);
        expect(roleCanUseTool('coder', 'sandbox_write_file', mode)).toBe(true);
        expect(roleCanUseTool('coder', 'sandbox_push', mode)).toBe(true);
      }
      // pr:write / workflow:trigger drop in local-daemon — no remote wired
      // up in that mode, regardless of role. (Follow-up to PR #559.)
      expect(roleHasCapability('coder', 'pr:write', 'cloud')).toBe(true);
      expect(roleHasCapability('coder', 'workflow:trigger', 'cloud')).toBe(true);
      expect(roleHasCapability('coder', 'pr:write', 'local-daemon')).toBe(false);
      expect(roleHasCapability('coder', 'workflow:trigger', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('coder', 'create_pr', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('coder', 'merge_pr', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('coder', 'delete_branch', 'local-daemon')).toBe(false);
      expect(roleCanUseTool('coder', 'trigger_workflow', 'local-daemon')).toBe(false);
    });

    it('auditor stays minimal in both modes', () => {
      for (const mode of ['cloud', 'local-daemon'] as const) {
        expect(roleCanUseTool('auditor', 'sandbox_read_file', mode)).toBe(true);
        expect(roleCanUseTool('auditor', 'sandbox_exec', mode)).toBe(false);
        expect(roleCanUseTool('auditor', 'sandbox_write_file', mode)).toBe(false);
      }
    });

    it('reviewer stays read+web in both modes', () => {
      for (const mode of ['cloud', 'local-daemon'] as const) {
        expect(roleCanUseTool('reviewer', 'sandbox_read_file', mode)).toBe(true);
        expect(roleCanUseTool('reviewer', 'web_search', mode)).toBe(true);
        expect(roleCanUseTool('reviewer', 'sandbox_exec', mode)).toBe(false);
        expect(roleCanUseTool('reviewer', 'sandbox_write_file', mode)).toBe(false);
      }
    });
  });

  describe('getEffectiveCapabilities — set-level invariants', () => {
    it('cloud orchestrator matches the static ROLE_CAPABILITIES entry', () => {
      const effective = getEffectiveCapabilities('orchestrator', 'cloud');
      expect(effective).toEqual(ROLE_CAPABILITIES.orchestrator);
    });

    it('local-daemon orchestrator adds branch + download extras and removes remote-only caps', () => {
      const cloudCaps = getEffectiveCapabilities('orchestrator', 'cloud');
      const daemonCaps = getEffectiveCapabilities('orchestrator', 'local-daemon');
      // Daemon-only: git:branch (local working tree) + sandbox:download (which
      // also authorizes promote_to_github, kept out of the cloud lead grant).
      for (const cap of ['git:branch', 'sandbox:download'] as const) {
        expect(daemonCaps.has(cap)).toBe(true);
        expect(cloudCaps.has(cap)).toBe(false);
      }
      // sandbox:exec/test are now shared (base grant) after the collapse.
      for (const cap of ['sandbox:exec', 'sandbox:test', 'repo:write'] as const) {
        expect(cloudCaps.has(cap)).toBe(true);
        expect(daemonCaps.has(cap)).toBe(true);
      }
      // git:commit is a LOCAL op — kept in daemon mode (and cloud).
      expect(cloudCaps.has('git:commit')).toBe(true);
      expect(daemonCaps.has('git:commit')).toBe(true);
      // Remote-bound caps present only in cloud (no remote in daemon): the
      // PR/workflow ops plus git:push.
      for (const cap of ['pr:write', 'workflow:trigger', 'git:push'] as const) {
        expect(cloudCaps.has(cap)).toBe(true);
        expect(daemonCaps.has(cap)).toBe(false);
      }
    });

    it('local-daemon orchestrator extras are exactly git:branch + sandbox:download', () => {
      const cloudCaps = getEffectiveCapabilities('orchestrator', 'cloud');
      const daemonCaps = getEffectiveCapabilities('orchestrator', 'local-daemon');
      const extras = new Set<Capability>();
      for (const cap of daemonCaps) {
        if (!cloudCaps.has(cap)) extras.add(cap);
      }
      // sandbox:exec/test moved to the base grant (collapse); git:branch and
      // sandbox:download stay daemon-only (download gates promote_to_github).
      expect(extras).toEqual(new Set<Capability>(['git:branch', 'sandbox:download']));
    });

    it('cloud-only orchestrator caps are the remote-bound PR/workflow + git:push', () => {
      const cloudCaps = getEffectiveCapabilities('orchestrator', 'cloud');
      const daemonCaps = getEffectiveCapabilities('orchestrator', 'local-daemon');
      const cloudOnly = new Set<Capability>();
      for (const cap of cloudCaps) {
        if (!daemonCaps.has(cap)) cloudOnly.add(cap);
      }
      // git:commit is NO LONGER cloud-only (local op kept in daemon); only the
      // genuinely remote-bound ops remain cloud-only. issue:write joins
      // pr:write/workflow:trigger as a remote-only cap stripped in local-daemon.
      expect(cloudOnly).toEqual(
        new Set<Capability>(['pr:write', 'issue:write', 'workflow:trigger', 'git:push']),
      );
    });
  });

  describe('enforceRoleCapability honors mode', () => {
    it('cloud orchestrator can exec — the collapse moved exec into the base grant', () => {
      const check = enforceRoleCapability('orchestrator', 'sandbox_exec', 'cloud');
      expect(check.ok).toBe(true);
    });

    it('local-daemon orchestrator can exec — same call passes the gate', () => {
      const check = enforceRoleCapability('orchestrator', 'sandbox_exec', 'local-daemon');
      expect(check.ok).toBe(true);
    });

    it('denial detail reports the effective grant for the mode (not the static one)', () => {
      // Auditor doesn't change between modes — sanity check the
      // detail still shows the role's effective grant.
      const check = enforceRoleCapability('auditor', 'sandbox_write_file', 'local-daemon');
      expect(check.ok).toBe(false);
      if (check.ok) return;
      expect(check.detail).toContain('Granted: repo:read');
      expect(check.detail).toContain('Mode: local-daemon');
    });
  });
});

// ---------------------------------------------------------------------------
// Drift detector — workspaceModeToExecutionMode is the single source of truth
// ---------------------------------------------------------------------------

describe('workspaceModeToExecutionMode — canonical WorkspaceMode → ExecutionMode mapping', () => {
  // This block is the "one source of truth per vocabulary" guard from
  // CLAUDE.md. The prompt builder (`app/src/lib/orchestrator.ts`) and
  // the runtime gate (`getExecutionMode` in
  // `lib/tool-execution-runtime.ts`) both funnel through this helper.
  // If a new WorkspaceMode lands or the daemon-bound set changes,
  // these assertions break before production behavior does.

  it('maps every WorkspaceMode value to a defined ExecutionMode (enum completeness)', () => {
    // Compile-time exhaustiveness — `ReadonlyArray<WorkspaceMode>`
    // alone would happily accept a strict subset (Copilot flagged
    // this on PR #554). Two-sided check instead:
    //   1. `satisfies readonly WorkspaceMode[]` rejects typos and
    //      values that aren't a `WorkspaceMode`.
    //   2. `Exclude<WorkspaceMode, (typeof allModes)[number]> extends
    //      never` rejects new variants that aren't listed here — if a
    //      future PR adds `'foo'` to `WorkspaceMode`, `_Exhaustive`
    //      becomes `false` and this file fails to compile.
    const allModes = [
      'repo',
      'scratch',
      'chat',
      'relay',
    ] as const satisfies readonly WorkspaceMode[];
    type _Exhaustive =
      Exclude<WorkspaceMode, (typeof allModes)[number]> extends never ? true : false;
    const _exhaustive: _Exhaustive = true;
    void _exhaustive;
    for (const mode of allModes) {
      const resolved: ExecutionMode = workspaceModeToExecutionMode(mode);
      expect(resolved === 'cloud' || resolved === 'local-daemon').toBe(true);
    }
  });

  it('maps the daemon-bound modes to local-daemon', () => {
    expect(workspaceModeToExecutionMode('relay')).toBe('local-daemon');
  });

  it('maps every other workspace mode to cloud', () => {
    expect(workspaceModeToExecutionMode('repo')).toBe('cloud');
    expect(workspaceModeToExecutionMode('scratch')).toBe('cloud');
    expect(workspaceModeToExecutionMode('chat')).toBe('cloud');
  });

  it('defaults to cloud for null / undefined / unknown inputs', () => {
    expect(workspaceModeToExecutionMode(null)).toBe('cloud');
    expect(workspaceModeToExecutionMode(undefined)).toBe('cloud');
    expect(workspaceModeToExecutionMode('made-up')).toBe('cloud');
  });
});

describe('getExecutionMode honors context.executionMode as the single source of truth', () => {
  it('prefers context.executionMode over binding-presence', () => {
    // Both inputs set, disagreeing — the named mode wins. This is the
    // drift class the seam eliminates: prompt and runtime see the
    // same resolved mode even if the binding ref propagates late or
    // a future code path sets a binding for a non-local reason.
    expect(getExecutionMode({ executionMode: 'cloud', localDaemonBinding: {} })).toBe('cloud');
    expect(getExecutionMode({ executionMode: 'local-daemon', localDaemonBinding: undefined })).toBe(
      'local-daemon',
    );
  });

  it('falls back to binding-presence when executionMode is unset (back-compat)', () => {
    expect(getExecutionMode({ localDaemonBinding: {} })).toBe('local-daemon');
    expect(getExecutionMode({ localDaemonBinding: undefined })).toBe('cloud');
  });

  it('agrees with workspaceModeToExecutionMode when both are derived from the same WorkspaceMode', () => {
    // Round-loop seam invariant: the chat hooks compute executionMode
    // from `workspaceContext.mode` via the helper and forward it onto
    // the runtime context. Both reads must agree. Same two-sided
    // compile-time exhaustiveness as the enum-completeness test
    // above — keeps this loop pinned to the full WorkspaceMode union.
    const modes = ['repo', 'scratch', 'chat', 'relay'] as const satisfies readonly WorkspaceMode[];
    type _Exhaustive = Exclude<WorkspaceMode, (typeof modes)[number]> extends never ? true : false;
    const _exhaustive: _Exhaustive = true;
    void _exhaustive;
    for (const mode of modes) {
      const promptSide = workspaceModeToExecutionMode(mode);
      const runtimeSide = getExecutionMode({ executionMode: promptSide });
      expect(runtimeSide).toBe(promptSide);
    }
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
