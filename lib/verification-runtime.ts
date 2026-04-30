import type { AcceptanceCriterion } from './runtime-contract.js';
import {
  extractCommandRules,
  type VerificationPolicy,
  type VerificationRequirementState,
  type VerificationRequirementStatus,
  type VerificationRule,
  type VerificationRuntimeState,
} from './verification-policy.js';

export type VerificationBoundary = 'completion' | 'commit';
export type VerificationGateOutcome = Exclude<
  VerificationRequirementStatus,
  'pending' | 'not_applicable'
>;
export type VerificationMutationSource = 'coder' | 'tool';

export interface VerificationEvaluation {
  passed: boolean;
  applicable: VerificationRequirementState[];
  missing: VerificationRequirementState[];
}

function normalizeCommand(command: string): string {
  return command
    .replace(/^cd\s+\/workspace\s+&&\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function commandsMatch(requiredCommand: string | undefined, executedCommand: string): boolean {
  if (!requiredCommand) return false;
  const required = normalizeCommand(requiredCommand);
  const executed = normalizeCommand(executedCommand);
  return executed === required || executed.includes(required);
}

function initialRuleStatus(
  rule: VerificationRule,
  backendTouched: boolean,
): VerificationRequirementStatus {
  if (rule.kind === 'gate') return 'not_applicable';
  if (rule.scope === 'backend' && !backendTouched) return 'not_applicable';
  return 'pending';
}

function toRequirementState(
  rule: VerificationRule,
  timestamp: number,
  backendTouched: boolean,
): VerificationRequirementState {
  return {
    id: rule.id,
    label: rule.label,
    scope: rule.scope,
    kind: rule.kind,
    command: rule.command,
    gate: rule.gate,
    status: initialRuleStatus(rule, backendTouched),
    updatedAt: timestamp,
  };
}

function shouldApplyRuleForBoundary(
  requirement: VerificationRequirementState,
  boundary: VerificationBoundary,
  backendTouched: boolean,
): boolean {
  if (boundary === 'completion' && requirement.scope === 'commit') return false;
  if (requirement.scope === 'backend' && !backendTouched) return false;
  if (requirement.kind === 'gate' && requirement.status === 'not_applicable') return false;
  return true;
}

function withTimestamp(
  requirement: VerificationRequirementState,
  status: VerificationRequirementStatus,
  detail: string | undefined,
  timestamp: number,
): VerificationRequirementState {
  return {
    ...requirement,
    status,
    detail,
    updatedAt: timestamp,
  };
}

function promoteBackendRules(
  requirements: VerificationRequirementState[],
  backendTouched: boolean,
  timestamp: number,
): VerificationRequirementState[] {
  if (!backendTouched) return requirements;
  return requirements.map((requirement) => {
    if (requirement.scope !== 'backend' || requirement.status !== 'not_applicable') {
      return requirement;
    }
    if (requirement.kind === 'gate') {
      return requirement;
    }
    return withTimestamp(requirement, 'pending', requirement.detail, timestamp);
  });
}

export function isBackendRelevantPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, '');

  if (!normalized) return false;
  if (/^documents\//.test(normalized)) return false;
  if (/^app\/src\/assets\//.test(normalized)) return false;
  if (/^app\/src\/components\//.test(normalized)) return false;
  if (/^app\/src\/sections\//.test(normalized)) return false;
  if (/\.(md|mdx|txt|png|jpg|jpeg|gif|svg|css|scss)$/i.test(normalized)) return false;

  return true;
}

export function extractChangedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;
    const [, fromPath, toPath] = match;
    const candidate = toPath === '/dev/null' ? fromPath : toPath;
    if (candidate && candidate !== '/dev/null') {
      paths.add(candidate);
    }
  }

  return [...paths];
}

export function hydrateVerificationRuntimeState(
  policy: VerificationPolicy,
  existing?: VerificationRuntimeState,
  timestamp = Date.now(),
): VerificationRuntimeState {
  const backendTouched = existing?.backendTouched ?? false;
  const previousById = new Map(
    existing?.requirements.map((requirement) => [requirement.id, requirement]) ?? [],
  );

  const requirements = policy.rules.map((rule) => {
    const previous = previousById.get(rule.id);
    if (
      !previous ||
      previous.kind !== rule.kind ||
      previous.scope !== rule.scope ||
      previous.command !== rule.command ||
      previous.gate !== rule.gate
    ) {
      return toRequirementState(rule, timestamp, backendTouched);
    }

    if (rule.scope === 'backend' && !backendTouched) {
      return withTimestamp(previous, 'not_applicable', previous.detail, previous.updatedAt);
    }

    if (rule.scope === 'backend' && previous.status === 'not_applicable' && rule.kind !== 'gate') {
      return withTimestamp(previous, 'pending', previous.detail, timestamp);
    }

    return {
      ...previous,
      label: rule.label,
      scope: rule.scope,
      kind: rule.kind,
      command: rule.command,
      gate: rule.gate,
    };
  });

  return {
    policyName: policy.name,
    backendTouched,
    requirements,
    lastUpdatedAt: Math.max(existing?.lastUpdatedAt ?? 0, timestamp),
  };
}

export function buildVerificationAcceptanceCriteria(
  policy: VerificationPolicy,
  scope: 'always' | 'backend' | 'commit' = 'always',
): AcceptanceCriterion[] {
  return extractCommandRules(policy, scope).map((rule) => ({
    id: `verification:${rule.id}`,
    check: rule.command!,
    description: `Verification: ${rule.label}`,
  }));
}

export function recordVerificationArtifact(
  state: VerificationRuntimeState,
  detail: string,
  timestamp = Date.now(),
): VerificationRuntimeState {
  return {
    ...state,
    requirements: state.requirements.map((requirement) => {
      if (requirement.kind !== 'evidence') return requirement;
      if (requirement.scope === 'backend' && !state.backendTouched) return requirement;
      return withTimestamp(requirement, 'passed', detail, timestamp);
    }),
    lastUpdatedAt: timestamp,
  };
}

export function recordVerificationMutation(
  state: VerificationRuntimeState,
  options: {
    source: VerificationMutationSource;
    touchedPaths?: string[];
    detail: string;
  },
  timestamp = Date.now(),
): VerificationRuntimeState {
  const touchedPaths = options.touchedPaths ?? [];
  const backendTouched = state.backendTouched || touchedPaths.some(isBackendRelevantPath);
  const promotedRequirements = promoteBackendRules(state.requirements, backendTouched, timestamp);

  const requirements = promotedRequirements.map((requirement) => {
    if (requirement.kind === 'evidence') {
      if (requirement.scope === 'backend' && !backendTouched) return requirement;
      return withTimestamp(requirement, 'passed', options.detail, timestamp);
    }

    if (requirement.kind === 'command') {
      if (requirement.scope === 'backend' && !backendTouched) return requirement;
      return withTimestamp(requirement, 'pending', `${options.detail} Re-run required.`, timestamp);
    }

    if (requirement.kind === 'gate') {
      if (options.source === 'coder') {
        return withTimestamp(
          requirement,
          'pending',
          'Pending post-coder gate evaluation.',
          timestamp,
        );
      }
      return withTimestamp(
        requirement,
        'not_applicable',
        'No coder gate required after direct tool mutation.',
        timestamp,
      );
    }

    return requirement;
  });

  return {
    ...state,
    backendTouched,
    requirements,
    lastUpdatedAt: timestamp,
  };
}

export function activateVerificationGate(
  state: VerificationRuntimeState,
  gate: string,
  detail = 'Gate evaluation pending.',
  timestamp = Date.now(),
): VerificationRuntimeState {
  return {
    ...state,
    requirements: state.requirements.map((requirement) =>
      requirement.kind === 'gate' && requirement.gate === gate
        ? withTimestamp(requirement, 'pending', detail, timestamp)
        : requirement,
    ),
    lastUpdatedAt: timestamp,
  };
}

export function recordVerificationGateResult(
  state: VerificationRuntimeState,
  gate: string,
  outcome: VerificationGateOutcome,
  detail: string,
  timestamp = Date.now(),
): VerificationRuntimeState {
  return {
    ...state,
    requirements: state.requirements.map((requirement) =>
      requirement.kind === 'gate' && requirement.gate === gate
        ? withTimestamp(requirement, outcome, detail, timestamp)
        : requirement,
    ),
    lastUpdatedAt: timestamp,
  };
}

export function recordVerificationCommandResult(
  state: VerificationRuntimeState,
  executedCommand: string,
  options: {
    exitCode: number;
    detail: string;
  },
  timestamp = Date.now(),
): VerificationRuntimeState {
  const outcome: VerificationRequirementStatus =
    options.exitCode === 0 ? 'passed' : options.exitCode < 0 ? 'inconclusive' : 'failed';

  const requirements = state.requirements.map((requirement) => {
    if (requirement.kind !== 'command') return requirement;
    if (requirement.scope === 'backend' && !state.backendTouched) return requirement;
    if (!commandsMatch(requirement.command, executedCommand)) return requirement;
    return withTimestamp(requirement, outcome, options.detail, timestamp);
  });

  return {
    ...state,
    requirements,
    lastUpdatedAt: timestamp,
  };
}

export function evaluateVerificationState(
  state: VerificationRuntimeState,
  boundary: VerificationBoundary,
): VerificationEvaluation {
  const applicable = state.requirements.filter((requirement) =>
    shouldApplyRuleForBoundary(requirement, boundary, state.backendTouched),
  );
  const missing = applicable.filter((requirement) => requirement.status !== 'passed');
  return {
    passed: missing.length === 0,
    applicable,
    missing,
  };
}

function summarizeRequirement(requirement: VerificationRequirementState): string {
  switch (requirement.kind) {
    case 'command':
      return requirement.command ? `Run \`${requirement.command}\`` : requirement.label;
    case 'gate':
      return requirement.gate ? `Satisfy the ${requirement.gate} gate` : requirement.label;
    default:
      return requirement.label;
  }
}

export function formatVerificationBlock(
  evaluation: VerificationEvaluation,
  boundary: VerificationBoundary,
): string {
  const heading =
    boundary === 'commit'
      ? 'Runtime verification blocked the commit flow because these requirements are still unmet:'
      : 'Runtime verification blocked the completion claim because these requirements are still unmet:';

  const lines = ['[VERIFICATION_BLOCK]', heading, ''];

  for (const requirement of evaluation.missing) {
    lines.push(
      `- [${requirement.id}] ${summarizeRequirement(requirement)} (status: ${requirement.status})`,
    );
    if (requirement.detail) {
      lines.push(`  ${requirement.detail}`);
    }
  }

  lines.push(
    '',
    'Continue the work until the runtime requirements are satisfied.',
    '[/VERIFICATION_BLOCK]',
  );
  return lines.join('\n');
}
