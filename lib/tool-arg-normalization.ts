/**
 * tool-arg-normalization.ts — coerce + validate tool-call arguments against
 * the registry's derived per-tool schema, before the call reaches an executor.
 *
 * Why this exists: Push routes one tool protocol across many providers (Claude,
 * GPT, Gemini, DeepSeek, Kimi, GLM, …). They agree on JSON *syntax* far more
 * than they agree on the *contract*: the same `{"tool","args"}` shape comes back
 * with `start_line: "5"` from one model and `start_line: 5` from another, `stat:
 * "true"` instead of `true`, a `pr` number quoted as a string, and so on. The
 * dispatcher (`tool-dispatch.ts`) already recovers an enormous range of on-the-
 * wire *formats*; what it did NOT do is reconcile argument *types*. Parsing
 * succeeded, the shape was `{tool, args}`, and the mistyped value flowed straight
 * to the executor — where a string where an integer was expected becomes a
 * silent downstream bug (range arithmetic on `"5"`, a version compare that never
 * matches, a boolean flag that's always truthy).
 *
 * This is the "valid JSON ≠ satisfies the contract" gap: the syntactic layer was
 * covered, the semantic layer was not. The schema to validate against already
 * exists — `tool-function-schemas.ts` derives an `input_schema` (types, required,
 * enum) per `ToolSpec` for native function calling — but its header notes it runs
 * best-effort and "nothing here runs in strict mode." This module is the strict
 * pass that schema was always implicitly describing, reused (not re-derived) so
 * the type source of truth stays single.
 *
 * Policy — deliberately conservative, non-breaking:
 *   - COERCE the safe, lossless scalar drift (string→integer/number/boolean,
 *     primitive→string). This is the dominant, high-frequency failure mode and
 *     fixing it changes a latent bug into a correct call.
 *   - REPORT (do not mutate, do not reject) everything else: a non-coercible type
 *     mismatch, a missing required field, an enum violation. Callers get these in
 *     the result and decide whether to surface them; the executor keeps its
 *     existing lenient behavior. Promoting a mismatch to a hard rejection is a
 *     separate policy choice and intentionally NOT made here.
 *
 * Pure: `normalizeToolArgs` never logs and never mutates its input. The symmetric
 * structured logging the repo convention asks for lives in `logToolArgOutcome`,
 * called at the wiring site (`tool-dispatch.ts`) so tests stay quiet and the
 * primitive stays composable.
 */

import { getToolSpec } from './tool-registry.js';
import { toolSpecToFunctionSchema, type ToolSchemaContext } from './tool-function-schemas.js';
import type { JsonSchemaType, ToolFunctionParameterSchema } from './provider-contract.js';

/** A value that was safely coerced from the type the model emitted to the type
 *  the schema declares. */
export interface ArgCoercion {
  param: string;
  /** JS runtime type of the value as the model emitted it. */
  fromType: RuntimeType;
  /** Schema-declared JSON type it was coerced to. */
  toType: JsonSchemaType;
}

export type ArgMismatchReason = 'type_mismatch' | 'missing_required' | 'enum_violation';

/** A drift the normalizer could NOT safely repair. Reported, never mutated. */
export interface ArgMismatch {
  param: string;
  reason: ArgMismatchReason;
  /** Schema-declared JSON type (absent for `missing_required` when the param
   *  has no declared type, though in practice every declared param has one). */
  expected?: JsonSchemaType;
  /** JS runtime type of the offending value (absent for `missing_required`). */
  actualType?: RuntimeType;
  /** For `enum_violation`: the closed value set the arg must be one of. */
  allowed?: readonly string[];
}

export interface NormalizeToolArgsResult {
  /** A NEW args object with safe coercions applied. Identical reference-wise to
   *  a shallow copy when nothing changed; the input is never mutated. */
  args: Record<string, unknown>;
  coercions: ArgCoercion[];
  mismatches: ArgMismatch[];
  /** True iff at least one value was coerced (i.e. `args` differs from input). */
  changed: boolean;
}

/** Narrow `typeof`/Array runtime classification used in coercion + reports. */
export type RuntimeType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null'
  | 'undefined';

function runtimeType(value: unknown): RuntimeType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object' || t === 'undefined') {
    return t;
  }
  // function / symbol / bigint never appear in parsed JSON; bucket as object so
  // the report has a stable shape rather than leaking an unexpected literal.
  return 'object';
}

/** Try to coerce `value` to the schema-declared `type`. Returns the coerced
 *  value when a SAFE, lossless conversion exists, otherwise `undefined` to
 *  signal "leave it, report a mismatch". A value already of the right type is
 *  returned as a no-op (caller compares identity to detect a real change). */
function coerceScalar(value: unknown, type: JsonSchemaType): unknown {
  switch (type) {
    case 'integer': {
      if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Strict integer literal only — no floats, no hex, no `"5abc"`.
        return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
      }
      return undefined;
    }
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return undefined;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      return undefined;
    }
    case 'string': {
      if (typeof value === 'string') return value;
      // A primitive emitted where a string was expected is safely stringified
      // (the inverse of the model's habit of quoting numbers). Objects/arrays
      // are NOT stringified — that would hide a real structural error.
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
      return undefined;
    }
    case 'array':
      // No coercion: wrapping a scalar in an array is too magical and routinely
      // wrong. Either it's an array or it's a mismatch.
      return Array.isArray(value) ? value : undefined;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Normalize one tool call's args against its registry-derived schema.
 *
 * Unknown tools (no registry spec) pass through untouched with empty
 * coercion/mismatch lists — the dispatcher reports those as `unknown_tool`
 * elsewhere, and there's no schema to validate against. Same for a tool whose
 * schema declares no parameters.
 *
 * `ctx` is forwarded to schema derivation; pass `activeRepo` only when the
 * caller actually wants the `repo`-pin enum enforced (the web/native paths that
 * bind the run to one repository). Omit it for generic dispatch so a correct
 * `owner/repo` isn't reported as an enum violation against an absent pin.
 */
export function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ToolSchemaContext,
): NormalizeToolArgsResult {
  const spec = getToolSpec(toolName);
  if (!spec) {
    return { args, coercions: [], mismatches: [], changed: false };
  }

  const schema = toolSpecToFunctionSchema(spec, ctx);
  const { properties, required } = schema.input_schema;

  const out: Record<string, unknown> = { ...args };
  const coercions: ArgCoercion[] = [];
  const mismatches: ArgMismatch[] = [];

  for (const [param, propSchema] of Object.entries(properties)) {
    const present = Object.prototype.hasOwnProperty.call(args, param) && args[param] !== undefined;

    if (!present) {
      if (required.includes(param)) {
        mismatches.push({ param, reason: 'missing_required', expected: propSchema.type });
      }
      continue;
    }

    const value = args[param];
    const coerced = coerceScalar(value, propSchema.type);

    if (coerced === undefined) {
      mismatches.push({
        param,
        reason: 'type_mismatch',
        expected: propSchema.type,
        actualType: runtimeType(value),
      });
      continue;
    }

    // Enum is checked against the (possibly coerced) value. Only string enums
    // exist today (the active-repo pin); compare on the string form.
    if (!checkEnum(coerced, propSchema, mismatches, param)) {
      continue;
    }

    if (!Object.is(coerced, value)) {
      out[param] = coerced;
      coercions.push({ param, fromType: runtimeType(value), toType: propSchema.type });
    }
  }

  return { args: out, coercions, mismatches, changed: coercions.length > 0 };
}

/** Returns false (and records an enum_violation) when a closed value set exists
 *  and the value is outside it. No enum → always passes. */
function checkEnum(
  value: unknown,
  propSchema: ToolFunctionParameterSchema,
  mismatches: ArgMismatch[],
  param: string,
): boolean {
  if (!propSchema.enum || propSchema.enum.length === 0) return true;
  if (typeof value === 'string' && propSchema.enum.includes(value)) return true;
  mismatches.push({
    param,
    reason: 'enum_violation',
    expected: propSchema.type,
    actualType: runtimeType(value),
    allowed: propSchema.enum,
  });
  return false;
}

/**
 * Emit symmetric structured logs for a normalization outcome. Called at the
 * dispatch wiring site, not inside `normalizeToolArgs`, so the primitive stays
 * pure and test output stays quiet.
 *
 * Stream is `console.error`: this module is shared `lib/` and runs on the CLI,
 * where stdout is reserved for user output and `--json` payloads (repo
 * convention — see `lib/git/repo-lock.ts`, `lib/context-memory.ts`). Event names
 * pair semantically: `tool_arg_coerced` ↔ `tool_arg_mismatch`.
 */
export function logToolArgOutcome(toolName: string, result: NormalizeToolArgsResult): void {
  if (result.coercions.length > 0) {
    console.error(
      JSON.stringify({
        level: 'info',
        event: 'tool_arg_coerced',
        tool: toolName,
        coercions: result.coercions,
      }),
    );
  }
  if (result.mismatches.length > 0) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'tool_arg_mismatch',
        tool: toolName,
        mismatches: result.mismatches,
      }),
    );
  }
}
