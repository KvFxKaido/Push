import { describe, it, expect } from 'vitest';
import {
  VERIFICATION_PRESETS,
  VERIFICATION_PRESET_STANDARD,
  VERIFICATION_PRESET_STRICT,
  VERIFICATION_PRESET_MINIMAL,
  getVerificationPreset,
  getVerificationPresetNames,
  formatVerificationPolicyBlock,
  extractCommandRules,
  policyRequiresGate,
  type VerificationPolicy,
} from './verification-policy';

// ---------------------------------------------------------------------------
// Preset well-formedness
// ---------------------------------------------------------------------------

describe('verification presets', () => {
  const allPresets = Object.values(VERIFICATION_PRESETS);

  it('all presets have a non-empty name', () => {
    for (const preset of allPresets) {
      expect(preset.name).toBeTruthy();
    }
  });

  it('all preset rules have required fields', () => {
    for (const preset of allPresets) {
      for (const rule of preset.rules) {
        expect(rule.id).toBeTruthy();
        expect(rule.label).toBeTruthy();
        expect(['always', 'backend', 'commit']).toContain(rule.scope);
        expect(['command', 'evidence', 'gate']).toContain(rule.kind);
      }
    }
  });

  it('command rules have a command string', () => {
    for (const preset of allPresets) {
      for (const rule of preset.rules) {
        if (rule.kind === 'command') {
          expect(rule.command).toBeTruthy();
        }
      }
    }
  });

  it('gate rules have a gate string', () => {
    for (const preset of allPresets) {
      for (const rule of preset.rules) {
        if (rule.kind === 'gate') {
          expect(rule.gate).toBeTruthy();
        }
      }
    }
  });

  it('standard preset has expected rules', () => {
    const ids = VERIFICATION_PRESET_STANDARD.rules.map((r) => r.id);
    expect(ids).toContain('diff-evidence');
    expect(ids).toContain('auditor-gate');
  });

  it('strict preset includes command rules', () => {
    const commandRules = VERIFICATION_PRESET_STRICT.rules.filter((r) => r.kind === 'command');
    expect(commandRules.length).toBeGreaterThan(0);
  });

  it('minimal preset has the fewest rules', () => {
    expect(VERIFICATION_PRESET_MINIMAL.rules.length).toBeLessThan(
      VERIFICATION_PRESET_STANDARD.rules.length,
    );
    expect(VERIFICATION_PRESET_MINIMAL.rules.length).toBeLessThan(
      VERIFICATION_PRESET_STRICT.rules.length,
    );
  });
});

// ---------------------------------------------------------------------------
// getVerificationPreset
// ---------------------------------------------------------------------------

describe('getVerificationPreset', () => {
  it('returns preset by lowercase name', () => {
    expect(getVerificationPreset('standard')).toBe(VERIFICATION_PRESET_STANDARD);
    expect(getVerificationPreset('strict')).toBe(VERIFICATION_PRESET_STRICT);
    expect(getVerificationPreset('minimal')).toBe(VERIFICATION_PRESET_MINIMAL);
  });

  it('is case-insensitive', () => {
    expect(getVerificationPreset('Standard')).toBe(VERIFICATION_PRESET_STANDARD);
    expect(getVerificationPreset('STRICT')).toBe(VERIFICATION_PRESET_STRICT);
    expect(getVerificationPreset('Minimal')).toBe(VERIFICATION_PRESET_MINIMAL);
  });

  it('returns undefined for unknown names', () => {
    expect(getVerificationPreset('nonexistent')).toBeUndefined();
    expect(getVerificationPreset('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getVerificationPresetNames
// ---------------------------------------------------------------------------

describe('getVerificationPresetNames', () => {
  it('returns all preset names', () => {
    const names = getVerificationPresetNames();
    expect(names).toContain('standard');
    expect(names).toContain('strict');
    expect(names).toContain('minimal');
    expect(names).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// formatVerificationPolicyBlock
// ---------------------------------------------------------------------------

describe('formatVerificationPolicyBlock', () => {
  it('returns null for undefined policy', () => {
    expect(formatVerificationPolicyBlock(undefined)).toBeNull();
  });

  it('returns null for policy with no rules', () => {
    const empty: VerificationPolicy = { name: 'Empty', rules: [] };
    expect(formatVerificationPolicyBlock(empty)).toBeNull();
  });

  it('formats header and footer correctly', () => {
    const block = formatVerificationPolicyBlock(VERIFICATION_PRESET_STANDARD)!;
    expect(block).toContain('[VERIFICATION_POLICY] Standard');
    expect(block).toContain('[/VERIFICATION_POLICY]');
    expect(block).toContain('You MUST satisfy applicable rules');
  });

  it('includes scope labels for non-always rules', () => {
    const block = formatVerificationPolicyBlock(VERIFICATION_PRESET_STRICT)!;
    expect(block).toContain('(backend only)');
    // 'always' scope rules should NOT have a scope label
    expect(block).not.toContain('(always only)');
  });

  it('includes command details for command rules', () => {
    const block = formatVerificationPolicyBlock(VERIFICATION_PRESET_STRICT)!;
    expect(block).toContain('`npx tsc --noEmit`');
    expect(block).toContain('`npm test`');
  });

  it('includes gate details for gate rules', () => {
    const block = formatVerificationPolicyBlock(VERIFICATION_PRESET_STANDARD)!;
    expect(block).toContain('require: auditor');
  });

  it('includes all rule ids', () => {
    const block = formatVerificationPolicyBlock(VERIFICATION_PRESET_STRICT)!;
    expect(block).toContain('[typecheck]');
    expect(block).toContain('[test]');
    expect(block).toContain('[diff-evidence]');
    expect(block).toContain('[auditor-gate]');
  });
});

// ---------------------------------------------------------------------------
// extractCommandRules
// ---------------------------------------------------------------------------

describe('extractCommandRules', () => {
  it('returns empty array for undefined policy', () => {
    expect(extractCommandRules(undefined)).toEqual([]);
  });

  it('returns only command-kind rules', () => {
    const commands = extractCommandRules(VERIFICATION_PRESET_STRICT);
    expect(commands.every((r) => r.kind === 'command')).toBe(true);
    expect(commands.length).toBe(2); // typecheck + test
  });

  it('returns empty for policies with no command rules', () => {
    const commands = extractCommandRules(VERIFICATION_PRESET_MINIMAL);
    expect(commands).toEqual([]);
  });

  it('filters by scope when provided', () => {
    // scope='always' should return only typecheck (scope='always')
    const alwaysCommands = extractCommandRules(VERIFICATION_PRESET_STRICT, 'always');
    expect(alwaysCommands.length).toBe(1);
    expect(alwaysCommands[0].id).toBe('typecheck');

    // scope='backend' should return both typecheck (always) and test (backend)
    const backendCommands = extractCommandRules(VERIFICATION_PRESET_STRICT, 'backend');
    expect(backendCommands.length).toBe(2);

    // scope='commit' should return only typecheck (always matches any scope filter)
    const commitCommands = extractCommandRules(VERIFICATION_PRESET_STRICT, 'commit');
    expect(commitCommands.length).toBe(1);
    expect(commitCommands[0].id).toBe('typecheck');
  });
});

// ---------------------------------------------------------------------------
// policyRequiresGate
// ---------------------------------------------------------------------------

describe('policyRequiresGate', () => {
  it('returns false for undefined policy', () => {
    expect(policyRequiresGate(undefined, 'auditor')).toBe(false);
  });

  it('returns true when gate rule exists', () => {
    expect(policyRequiresGate(VERIFICATION_PRESET_STANDARD, 'auditor')).toBe(true);
  });

  it('returns false for non-existent gate', () => {
    expect(policyRequiresGate(VERIFICATION_PRESET_STANDARD, 'reviewer')).toBe(false);
  });

  it('returns false for policy with no gate rules', () => {
    expect(policyRequiresGate(VERIFICATION_PRESET_MINIMAL, 'auditor')).toBe(false);
  });
});
