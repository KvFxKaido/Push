import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

// Both packages publish CommonJS entry points. NodeNext correctly models their
// runtime namespace shape, but a synthetic default import is not callable in
// declaration builds, so load the plugin through Node's explicit CJS bridge.
const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => Ajv2020;

const MAX_SCHEMA_BYTES = 256_000;
const MAX_REPAIR_CONTEXT_CHARS = 50_000;

export const DEFAULT_OUTPUT_SCHEMA_REPAIRS = 2;

export interface CompiledOutputSchema {
  path: string;
  schema: boolean | Record<string, unknown>;
  source: string;
  validate: ValidateFunction;
}

export type OutputValidationResult =
  | { ok: true; text: string; value: unknown }
  | { ok: false; error: string };

export type ConstrainedOutputResult =
  | { ok: true; text: string; value: unknown; repairs: number }
  | { ok: false; error: string; repairs: number; lastCandidate: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'output did not satisfy the schema';
  return errors
    .slice(0, 8)
    .map((error) => {
      const location = error.instancePath || '(root)';
      return `${location} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/** Read and compile a Draft 2020-12 JSON Schema before the agent run starts. */
export async function loadOutputSchema(
  schemaPath: string,
  baseDir: string = process.cwd(),
): Promise<CompiledOutputSchema> {
  const resolvedPath = path.resolve(baseDir, schemaPath);
  let source: string;
  try {
    source = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read --output-schema ${resolvedPath}: ${message}`);
  }

  if (Buffer.byteLength(source, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error(
      `--output-schema exceeds the ${MAX_SCHEMA_BYTES.toLocaleString()} byte limit: ${resolvedPath}`,
    );
  }

  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--output-schema is not valid JSON (${resolvedPath}): ${message}`);
  }
  if (typeof schema !== 'boolean' && !isJsonObject(schema)) {
    throw new Error(`--output-schema must contain a JSON Schema: ${resolvedPath}`);
  }

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    return {
      path: resolvedPath,
      schema,
      source: JSON.stringify(schema),
      validate,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--output-schema is not a supported Draft 2020-12 schema: ${message}`);
  }
}

/** Parse exact JSON and validate it. Markdown fences and prose deliberately fail. */
export function validateOutputText(
  raw: string,
  compiled: CompiledOutputSchema,
): OutputValidationResult {
  const candidate = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'final response was not valid JSON' };
  }

  if (!compiled.validate(value)) {
    return { ok: false, error: formatAjvErrors(compiled.validate.errors) };
  }
  return { ok: true, text: JSON.stringify(value), value };
}

export function formatOutputSchemaInstruction(compiled: CompiledOutputSchema): string {
  return [
    '[OUTPUT_SCHEMA]',
    'Complete the task normally, including any tool use that is needed.',
    'Your final response must be exactly one JSON value matching the JSON Schema below.',
    'Do not wrap the final JSON in Markdown fences or add prose outside it.',
    compiled.source,
    '[/OUTPUT_SCHEMA]',
  ].join('\n');
}

function clipRepairContext(value: string): string {
  if (value.length <= MAX_REPAIR_CONTEXT_CHARS) return value;
  return `${value.slice(0, MAX_REPAIR_CONTEXT_CHARS)}\n[truncated]`;
}

export function buildOutputRepairPrompt(
  compiled: CompiledOutputSchema,
  task: string,
  candidate: string,
  validationError: string,
): string {
  return [
    'Repair only the final machine-readable output. The task itself has already run.',
    "Do not perform, repeat, or claim any tool actions. Preserve the candidate's meaning.",
    'Return exactly one JSON value matching the schema, with no Markdown or surrounding prose.',
    '',
    '[ORIGINAL_TASK]',
    clipRepairContext(task),
    '[/ORIGINAL_TASK]',
    '',
    '[JSON_SCHEMA]',
    compiled.source,
    '[/JSON_SCHEMA]',
    '',
    '[INVALID_CANDIDATE]',
    clipRepairContext(candidate),
    '[/INVALID_CANDIDATE]',
    '',
    '[VALIDATION_ERROR]',
    validationError,
    '[/VALIDATION_ERROR]',
  ].join('\n');
}

/** Validate once, then make bounded output-only repair calls on failure. */
export async function constrainOutputToSchema(
  compiled: CompiledOutputSchema,
  task: string,
  initialCandidate: string,
  generateRepair: (prompt: string, attempt: number) => Promise<string>,
  maxRepairs: number = DEFAULT_OUTPUT_SCHEMA_REPAIRS,
): Promise<ConstrainedOutputResult> {
  let candidate = initialCandidate;
  let lastError = '';

  for (let repairs = 0; repairs <= maxRepairs; repairs += 1) {
    const validation = validateOutputText(candidate, compiled);
    if (validation.ok) {
      return { ...validation, repairs };
    }
    lastError = validation.error;
    if (repairs === maxRepairs) {
      return { ok: false, error: lastError, repairs, lastCandidate: candidate };
    }
    candidate = await generateRepair(
      buildOutputRepairPrompt(compiled, task, candidate, lastError),
      repairs + 1,
    );
  }

  // The bounded loop always returns; this keeps TypeScript's control-flow
  // analysis honest if the loop shape changes later.
  return { ok: false, error: lastError, repairs: maxRepairs, lastCandidate: candidate };
}
