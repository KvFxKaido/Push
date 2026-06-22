/**
 * Auditor gate policy — the single source of truth for the cross-surface
 * "should delivery go through the Auditor SAFE/UNSAFE gate?" setting.
 *
 * The Auditor (lib/auditor-agent.ts) is a documented required delivery gate
 * (ARCHITECTURE.md): web/cloud applies it at the push boundary, while CLI
 * `git_commit` applies it before the commit lands. It is **opt-out**: on by
 * default, disabled per-surface via config or the shared env var. Keeping the
 * vocabulary (env var name, default, parser, resolution precedence) here means
 * both the CLI/daemon and the web/worker resolve the toggle identically — no
 * per-surface drift. See cli/tests/auditor-policy.test.mjs for the pinned
 * contract.
 *
 * Resolution precedence (highest wins):
 *   1. env var (operator override — `PUSH_AUDITOR_GATE`)
 *   2. explicit per-surface setting (CLI `config.auditorGate`, web harness
 *      setting)
 *   3. default (`AUDITOR_GATE_DEFAULT`)
 */

/** Env var that toggles the Auditor delivery gate across surfaces. */
export const AUDITOR_GATE_ENV_VAR = 'PUSH_AUDITOR_GATE';

/**
 * Default state when nothing explicitly opts in: ON. The Auditor delivery gate
 * is a documented hard invariant ("required SAFE/UNSAFE gate", per
 * ARCHITECTURE.md), so it is enabled unless a surface explicitly opts out via
 * config / the shared env var. Disabling it is a deliberate user choice.
 */
export const AUDITOR_GATE_DEFAULT = true;

/**
 * Parse a loosely-typed setting value into a boolean, or `undefined` when the
 * value carries no opinion (absent / empty / unrecognized). Returning
 * `undefined` — rather than coercing — is what lets the resolution fall through
 * to the next precedence tier instead of a blank string silently meaning
 * `false`.
 */
export function parseBooleanSetting(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value !== 0;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolve whether the Auditor delivery gate is enabled. Pure — callers pass the
 * raw env value and the raw per-surface setting; the precedence + default live
 * here so every surface agrees.
 */
export function resolveAuditorGateEnabled(
  opts: { explicit?: unknown; env?: unknown } = {},
): boolean {
  const fromEnv = parseBooleanSetting(opts.env);
  if (fromEnv !== undefined) return fromEnv;
  const fromExplicit = parseBooleanSetting(opts.explicit);
  if (fromExplicit !== undefined) return fromExplicit;
  return AUDITOR_GATE_DEFAULT;
}
