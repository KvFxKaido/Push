/**
 * structured-output.ts — Schema-validated parsing of model JSON responses.
 *
 * Problem this solves: several role kernels (auditor verdict, auditor
 * evaluation, reviewer) ask a model to emit a JSON object, then hand-roll
 * the same three-step dance to read it back:
 *
 *   1. strip a ```json ... ``` markdown fence,
 *   2. `JSON.parse` the inner text,
 *   3. coerce each field with ad-hoc `typeof` / `Array.isArray` guards and
 *      fall back to a default when the shape is wrong.
 *
 * That pattern had drifted between sites (the fence regex was copied four
 * times) and the failure branches were silent `catch {}` returns — invisible
 * to ops. This module centralizes the fence/parse step behind a single
 * `parseStructured` entry point that validates against a zod schema and
 * returns a discriminated result, so callers keep their fail-safe defaults
 * *and* can emit a structured log on the failure branch.
 *
 * Behavior parity: the per-field defaults the call sites used to apply
 * inline (unknown verdict → 'unsafe', missing summary → 'No summary
 * provided', etc.) now live declaratively in each schema via zod `.catch`,
 * so adopting this helper does not change which verdict a malformed-but-
 * parseable response produces.
 *
 * Resilience: parsing layers `applyJsonTextRepairs` (the shape-agnostic
 * LLM-garbling repairs from `tool-call-parsing.ts`) as a second attempt
 * when the raw `JSON.parse` throws. This is the same repair pass the
 * tool-dispatch path relies on; auditor/reviewer previously did a single
 * naked `JSON.parse` and got nothing from it.
 *
 * Dependency note: this is the first use of an external schema library
 * (`zod`) inside shared `lib/`, which the CLI imports. The CLI's
 * zero-external-deps convention (see `protocol-schema.ts`) is deliberately
 * relaxed for schema validation of model output — hand-rolled guards do
 * not scale to the structured-output surface and zod already ships with
 * the web app. Wire-envelope validation in `protocol-schema.ts` stays
 * hand-rolled.
 */

import { z } from 'zod';
import { applyJsonTextRepairs } from './tool-call-parsing.js';

/** Why a `parseStructured` call could not produce a validated object. */
export type StructuredFailureReason =
  /** Response was empty (or only whitespace / an empty fence). */
  | 'empty'
  /** Inner text did not parse as JSON, even after repair. */
  | 'json'
  /** Parsed JSON did not satisfy the schema. */
  | 'schema';

export type StructuredParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: StructuredFailureReason; error: string; raw: string };

export interface ParseStructuredOptions {
  /**
   * Apply `applyJsonTextRepairs` and re-parse when the first `JSON.parse`
   * throws. Defaults to `true`. The repairs only ever *recover* a response
   * that would otherwise have failed parsing, so they can be disabled where
   * a stricter "must be clean JSON" contract is wanted.
   */
  repair?: boolean;
}

// A single ```json ... ``` (or bare ```) fence wrapper. Mirrors the regex
// that used to be copy-pasted across the role kernels.
const JSON_FENCE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;

/** Strip a single markdown code fence around a JSON body, if present. */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(JSON_FENCE);
  return match ? match[1].trim() : trimmed;
}

function tryParseJson(text: string, repair: boolean): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    if (!repair) return null;
    try {
      return { value: JSON.parse(applyJsonTextRepairs(text)) };
    } catch {
      return null;
    }
  }
}

/**
 * Strip an optional markdown fence, parse the body as JSON (with repair
 * fallback), and validate it against `schema`. Never throws — the failure
 * mode is encoded in the returned discriminated union so callers can branch
 * and log instead of wrapping the call in a try/catch.
 */
export function parseStructured<S extends z.ZodType>(
  raw: string,
  schema: S,
  options: ParseStructuredOptions = {},
): StructuredParseResult<z.infer<S>> {
  const repair = options.repair ?? true;
  const candidate = stripJsonFence(raw);
  if (!candidate) {
    return { ok: false, reason: 'empty', error: 'empty model response', raw };
  }

  const parsed = tryParseJson(candidate, repair);
  if (!parsed) {
    return { ok: false, reason: 'json', error: 'response was not valid JSON', raw };
  }

  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, reason: 'schema', error: result.error.message, raw };
  }

  return { ok: true, data: result.data as z.infer<S> };
}
