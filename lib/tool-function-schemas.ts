/**
 * tool-function-schemas.ts — derive Anthropic-style custom-tool schemas for
 * Push's tools from the single tool registry (`tool-registry.ts`).
 *
 * Why this exists: Push's tool protocol is text-dispatch — tools are described
 * in the system prompt and the model emits fenced `{"tool","args"}` JSON. Some
 * providers (Cloudflare Workers AI's Kimi/GLM, etc.) also support *native*
 * function calling, which is more reliable than free-text JSON. Native provider
 * calls surface as structured stream events and still pass through the same
 * dispatcher validation; text-dispatch models keep using fenced JSON.
 *
 * The `tools` array must be COMPLETE — a partial list tells the model those are
 * its only tools — so this derives one schema per `ToolSpec`. Function `name`
 * is the `publicName` (e.g. `exec`, `read`): that's what the prompt teaches,
 * what `KNOWN_TOOL_NAMES` recognizes, and what `resolveToolName` maps back to
 * canonical, so a native call flushed as `{"tool": <publicName>}` dispatches.
 *
 * Parameter types come from a curated `PARAM_TYPES` map (authoritative),
 * falling back to the type inferred from each spec's `exampleJson` args, then
 * to `string`. Types are best-effort and that's fine: executors already accept
 * the model's free-form JSON on the text path, and nothing here runs in strict
 * mode. `tool-function-schemas.test.ts` pins completeness (every tool has a
 * schema; every signature param appears in its schema).
 */

import { getAllToolSpecs, type ToolSpec, type ToolRegistrySource } from './tool-registry.js';
import type {
  JsonSchemaType,
  ToolFunctionParameterSchema,
  ToolFunctionSchema,
} from './provider-contract.js';

export type { JsonSchemaType, ToolFunctionParameterSchema, ToolFunctionSchema };

/**
 * Curated parameter-name → JSON type map. Keyed by the argument names used in
 * `protocolSignature` across the registry. Anything absent here falls back to
 * the type inferred from the spec's `exampleJson`, then to `string`. Update
 * this when a new tool introduces a non-string argument name.
 */
const PARAM_TYPES: Record<string, JsonSchemaType> = {
  // integers
  pr: 'integer',
  count: 'integer',
  run_id: 'integer',
  pr_number: 'integer',
  start_line: 'integer',
  end_line: 'integer',
  limit: 'integer',
  // `expected_version` is the hashline version token — runtime-typed `string`
  // (`lib/sandbox-provider.ts`), NOT a number, even though it often *looks*
  // numeric. It defaults to `string` here, but is listed explicitly so it
  // isn't mistakenly re-added as `integer`: that would make the normalizer
  // coerce a valid `"42"` to `42` and hard-reject a non-numeric version token.
  expected_version: 'string',
  // booleans
  stat: 'boolean',
  private: 'boolean',
  multiSelect: 'boolean',
  dryRun: 'boolean',
  diagnostics: 'boolean',
  rollbackOnFailure: 'boolean',
  replace_all: 'boolean',
  // arrays — `checks` on `patch` is an array of `{command, exitCode?,
  // timeoutMs?}` objects (`sandbox-tool-detection.ts`), NOT a boolean flag.
  checks: 'array',
  // arrays
  tasks: 'array',
  files: 'array',
  paths: 'array',
  todos: 'array',
  edits: 'array',
  options: 'array',
  kinds: 'array',
  ids: 'array',
  dependencies: 'array',
  acceptanceCriteria: 'array',
  declaredCapabilities: 'array',
  knownContext: 'array',
  constraints: 'array',
  // objects
  inputs: 'object',
};

/** Array params whose elements are objects (vs strings). */
const OBJECT_ARRAY_PARAMS = new Set(['tasks', 'todos', 'edits', 'checks']);

/** Parse `name(a, b?, c)` → ordered params with required derived from `?`. */
function parseSignatureParams(signature: string): Array<{ name: string; required: boolean }> {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = signature.slice(open + 1, close).trim();
  if (!inner) return [];
  return inner.split(',').map((raw) => {
    const token = raw.trim();
    const optional = token.endsWith('?');
    return { name: optional ? token.slice(0, -1).trim() : token, required: !optional };
  });
}

/** Infer a JSON type from an example arg value. */
function inferType(value: unknown): JsonSchemaType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

/** Read the `args` object out of a spec's `exampleJson` (best-effort). */
function parseExampleArgs(exampleJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(exampleJson) as { args?: unknown };
    return parsed && typeof parsed.args === 'object' && parsed.args
      ? (parsed.args as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveParamType(name: string, exampleArgs: Record<string, unknown>): JsonSchemaType {
  if (name in PARAM_TYPES) return PARAM_TYPES[name];
  if (name in exampleArgs) return inferType(exampleArgs[name]);
  return 'string';
}

function buildParameterSchema(
  name: string,
  exampleArgs: Record<string, unknown>,
): ToolFunctionParameterSchema {
  const type = resolveParamType(name, exampleArgs);
  if (type === 'array') {
    return { type, items: { type: OBJECT_ARRAY_PARAMS.has(name) ? 'object' : 'string' } };
  }
  return { type };
}

/** Options that bind otherwise-free-form args to the run's context. */
export interface ToolSchemaContext {
  /**
   * The single repository the run may touch. When set, GitHub tools' `repo`
   * param is pinned to it (enum + description) so the model emits the active
   * repo instead of a placeholder like `owner/repo` — the latter trips the
   * executor's repo-mismatch rejection (seen as `validation_failed` retries on
   * Kimi/GLM native calls). No effect on non-GitHub tools.
   */
  activeRepo?: string;
  /**
   * Canonical tool names to omit from the schema set even though their source
   * is included. The Inline Foreground Lane wires the `delegate` source for
   * `delegate_explorer` only, so it excludes `delegate_coder` / `plan_tasks` —
   * advertising a tool the run can't execute would let a native call silently
   * no-op (see the source-scoping note on `getToolFunctionSchemasForSources`).
   */
  excludeTools?: ReadonlySet<string>;
}

/** Build the function-calling schema for a single tool spec. */
export function toolSpecToFunctionSchema(
  spec: ToolSpec,
  ctx?: ToolSchemaContext,
): ToolFunctionSchema {
  const params = parseSignatureParams(spec.protocolSignature);
  const exampleArgs = parseExampleArgs(spec.exampleJson);
  const properties: Record<string, ToolFunctionParameterSchema> = {};
  const required: string[] = [];
  for (const param of params) {
    let prop = buildParameterSchema(param.name, exampleArgs);
    if (param.name === 'repo' && spec.source === 'github' && ctx?.activeRepo) {
      prop = {
        ...prop,
        enum: [ctx.activeRepo],
        description: `The active repository. Must be exactly "${ctx.activeRepo}".`,
      };
    }
    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }
  return {
    name: spec.publicName,
    description: spec.protocolDescription,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

let cached: ToolFunctionSchema[] | null = null;

/**
 * The complete function-calling schema set for every registry tool. Memoized —
 * the registry is static. Callers attach this as the `tools` array for models
 * that support native function calling.
 */
export function getToolFunctionSchemas(): ToolFunctionSchema[] {
  if (!cached) cached = getAllToolSpecs().map((spec) => toolSpecToFunctionSchema(spec));
  return cached;
}

/**
 * Function schemas for only the given tool `source`s. Callers MUST scope the
 * `tools` array to the surface they actually wire — a native call to an
 * advertised-but-unexecutable tool (e.g. the lead has no `delegate` arc) is
 * filtered by the detectors and silently no-ops. Pass exactly the sources whose
 * executors are wired for the run.
 */
export function getToolFunctionSchemasForSources(
  sources: ReadonlySet<ToolRegistrySource>,
  ctx?: ToolSchemaContext,
): ToolFunctionSchema[] {
  return getAllToolSpecs()
    .filter((spec) => sources.has(spec.source) && !ctx?.excludeTools?.has(spec.canonicalName))
    .map((spec) => toolSpecToFunctionSchema(spec, ctx));
}
