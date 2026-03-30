/**
 * verification-policy.ts
 *
 * Session-level verification policy for Track C of the Harness Runtime
 * Evolution Plan.
 *
 * Lets a chat/session carry durable verification expectations instead of
 * treating verification as a one-off delegation concern.
 */

/** Individual verification requirement. */
export interface VerificationRule {
  /** Unique rule identifier (e.g., 'typecheck', 'test', 'diff-evidence'). */
  id: string;
  /** Human-readable description shown in UI and injected into agent context. */
  label: string;
  /**
   * When this rule applies:
   * - 'always' — every completion claim
   * - 'backend' — only when backend files are touched
   * - 'commit' — only before commit prep
   */
  scope: 'always' | 'backend' | 'commit';
  /**
   * What kind of verification this requires:
   * - 'command' — run a shell command (e.g., npm test)
   * - 'evidence' — require diff/artifact evidence in the response
   * - 'gate' — require a specific agent gate (e.g., auditor)
   */
  kind: 'command' | 'evidence' | 'gate';
  /** For 'command' kind: the shell command to run. */
  command?: string;
  /** For 'gate' kind: which gate (e.g., 'auditor'). */
  gate?: string;
}

/** A complete verification policy attached to a session. */
export interface VerificationPolicy {
  /** Display name for the policy (e.g., 'Strict', 'Standard'). */
  name: string;
  /** The rules that make up this policy. */
  rules: VerificationRule[];
}

// --- Presets ---

export const VERIFICATION_PRESET_STANDARD: VerificationPolicy = {
  name: 'Standard',
  rules: [
    {
      id: 'diff-evidence',
      label: 'Require diff or artifact evidence before completion claims',
      scope: 'always',
      kind: 'evidence',
    },
    {
      id: 'auditor-gate',
      label: 'Run auditor evaluation after coder delegation',
      scope: 'always',
      kind: 'gate',
      gate: 'auditor',
    },
  ],
};

export const VERIFICATION_PRESET_STRICT: VerificationPolicy = {
  name: 'Strict',
  rules: [
    {
      id: 'typecheck',
      label: 'Run typecheck before claiming done',
      scope: 'always',
      kind: 'command',
      command: 'npx tsc --noEmit',
    },
    {
      id: 'test',
      label: 'Run tests before claiming done',
      scope: 'backend',
      kind: 'command',
      command: 'npm test',
    },
    {
      id: 'diff-evidence',
      label: 'Require diff or artifact evidence before completion claims',
      scope: 'always',
      kind: 'evidence',
    },
    {
      id: 'auditor-gate',
      label: 'Run auditor evaluation after coder delegation',
      scope: 'always',
      kind: 'gate',
      gate: 'auditor',
    },
  ],
};

export const VERIFICATION_PRESET_MINIMAL: VerificationPolicy = {
  name: 'Minimal',
  rules: [
    {
      id: 'diff-evidence',
      label: 'Require diff or artifact evidence before completion claims',
      scope: 'always',
      kind: 'evidence',
    },
  ],
};

export const VERIFICATION_PRESETS: Record<string, VerificationPolicy> = {
  standard: VERIFICATION_PRESET_STANDARD,
  strict: VERIFICATION_PRESET_STRICT,
  minimal: VERIFICATION_PRESET_MINIMAL,
};

/** Clone a policy so persisted conversations do not share mutable preset objects. */
export function cloneVerificationPolicy(policy: VerificationPolicy): VerificationPolicy {
  return {
    name: policy.name,
    rules: policy.rules.map((rule) => ({ ...rule })),
  };
}

/** Default policy for new chats/sessions. */
export function getDefaultVerificationPolicy(): VerificationPolicy {
  return cloneVerificationPolicy(VERIFICATION_PRESET_STANDARD);
}

/** Resolve a session policy, falling back to the standard preset. */
export function resolveVerificationPolicy(
  policy: VerificationPolicy | undefined,
): VerificationPolicy {
  return policy ?? VERIFICATION_PRESET_STANDARD;
}

/** Look up a preset by name, case-insensitive. Returns undefined if not found. */
export function getVerificationPreset(name: string): VerificationPolicy | undefined {
  return VERIFICATION_PRESETS[name.toLowerCase()];
}

/** Get all available preset names. */
export function getVerificationPresetNames(): string[] {
  return Object.keys(VERIFICATION_PRESETS);
}

/**
 * Format a verification policy into a structured block for injection into
 * agent system prompts. Returns null if the policy has no rules.
 */
export function formatVerificationPolicyBlock(policy: VerificationPolicy | undefined): string | null {
  if (!policy || policy.rules.length === 0) return null;

  const lines = [
    `[VERIFICATION_POLICY] ${policy.name}`,
    '',
    'The following verification requirements are active for this session.',
    'You MUST satisfy applicable rules before claiming work is complete.',
    '',
  ];

  for (const rule of policy.rules) {
    const scopeLabel = rule.scope === 'always' ? '' : ` (${rule.scope} only)`;
    const kindDetail = rule.kind === 'command' && rule.command
      ? ` → run: \`${rule.command}\``
      : rule.kind === 'gate' && rule.gate
        ? ` → require: ${rule.gate}`
        : '';
    lines.push(`- [${rule.id}]${scopeLabel}: ${rule.label}${kindDetail}`);
  }

  lines.push('', '[/VERIFICATION_POLICY]');
  return lines.join('\n');
}

/**
 * Extract command-type rules from a policy.
 * Used to build acceptance criteria from policy rules.
 */
export function extractCommandRules(
  policy: VerificationPolicy | undefined,
  scope?: 'always' | 'backend' | 'commit',
): VerificationRule[] {
  if (!policy) return [];
  return policy.rules.filter(r =>
    r.kind === 'command' &&
    r.command &&
    (!scope || r.scope === 'always' || r.scope === scope),
  );
}

/**
 * Check whether a policy requires a specific gate.
 */
export function policyRequiresGate(
  policy: VerificationPolicy | undefined,
  gate: string,
): boolean {
  if (!policy) return false;
  return policy.rules.some(r => r.kind === 'gate' && r.gate === gate);
}
