import type {
  JsonSchemaType,
  ToolFunctionParameterSchema,
  ToolFunctionSchema,
} from '../lib/provider-contract.ts';
import {
  getToolFunctionSchemasForSources,
  type ToolSchemaContext,
} from '../lib/tool-function-schemas.ts';
import type { ToolRegistrySource } from '../lib/tool-registry.ts';
import { READ_ONLY_TOOL_PROTOCOL, TOOL_PROTOCOL } from './tools.js';

const CLI_TOOL_LINE_RE = /^- ([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\) \u2014 ([^\n]+)$/gm;
const GITHUB_TOOL_SOURCE = new Set<ToolRegistrySource>(['github']);

const PARAM_TYPES: Record<string, JsonSchemaType> = {
  start_line: 'integer',
  end_line: 'integer',
  max_results: 'integer',
  timeout_ms: 'integer',
  // CLI exec session ids are strings (`exec_<base36>_<n>`, see `cli/tools.ts`),
  // and the exec_poll/write/stop executors call `asString(session_id)`. Typing
  // this `integer` in the native schema made the model emit a number, so
  // follow-up calls failed with `session_id must be a string`.
  session_id: 'string',
  from_seq: 'integer',
  max_chars: 'integer',
  expected_version: 'integer',
  limit: 'integer',
  staged: 'boolean',
  tty: 'boolean',
  append_newline: 'boolean',
  edits: 'array',
  paths: 'array',
  files: 'array',
  // delegate_explorer brief fields (lead Explorer fan-out — see
  // `cli/lead-explorer.ts:LEAD_EXPLORER_DELEGATION_PROTOCOL`).
  knownContext: 'array',
  constraints: 'array',
  dependencies: 'array',
  choices: 'array',
  kinds: 'array',
  ids: 'array',
  refs: 'array',
  openTasks: 'array',
  filesTouched: 'array',
  assumptions: 'array',
  errorsEncountered: 'array',
  completedPhases: 'array',
  entry: 'object',
};

const OBJECT_ARRAY_PARAMS = new Set(['edits']);

function buildParameterSchema(name: string): ToolFunctionParameterSchema {
  const type = PARAM_TYPES[name] ?? 'string';
  if (type === 'array') {
    return { type, items: { type: OBJECT_ARRAY_PARAMS.has(name) ? 'object' : 'string' } };
  }
  return { type };
}

function parseProtocolSchemas(protocol: string): ToolFunctionSchema[] {
  const schemas: ToolFunctionSchema[] = [];
  for (const match of protocol.matchAll(CLI_TOOL_LINE_RE)) {
    const [, name, rawParams, description] = match;
    const properties: Record<string, ToolFunctionParameterSchema> = {};
    const required: string[] = [];
    for (const rawParam of rawParams
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)) {
      const optional = rawParam.endsWith('?');
      const paramName = optional ? rawParam.slice(0, -1).trim() : rawParam;
      properties[paramName] = buildParameterSchema(paramName);
      if (!optional) required.push(paramName);
    }
    schemas.push({
      name,
      description,
      input_schema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
  return schemas;
}

let fullCliSchemas: ToolFunctionSchema[] | null = null;
let readOnlyCliSchemas: ToolFunctionSchema[] | null = null;

export interface CliToolSchemaOptions extends ToolSchemaContext {
  includeGitHub?: boolean;
  /**
   * Additional CLI-format protocol blocks to parse for native schemas beyond
   * `TOOL_PROTOCOL` — each block's `- name(params) — description` lines are
   * parsed with the same grammar. The lead lane threads its Explorer
   * delegation block here (`cli/lead-explorer.ts`) so the advertised prompt
   * text and the native function schema come from one definition; surfaces
   * that don't wire the matching executor omit it, keeping advertising
   * aligned with executor support.
   */
  extraProtocolBlocks?: string[];
}

export function getCliNativeToolSchemas(options: CliToolSchemaOptions = {}): ToolFunctionSchema[] {
  if (!fullCliSchemas) fullCliSchemas = parseProtocolSchemas(TOOL_PROTOCOL);
  const extras = (options.extraProtocolBlocks ?? []).flatMap((block) =>
    parseProtocolSchemas(block),
  );
  const base = extras.length > 0 ? [...fullCliSchemas, ...extras] : fullCliSchemas;
  if (!options.includeGitHub) return base;
  return [
    ...base,
    ...getToolFunctionSchemasForSources(GITHUB_TOOL_SOURCE, {
      activeRepo: options.activeRepo,
      excludeTools: options.excludeTools,
    }),
  ];
}

export function getCliReadOnlyNativeToolSchemas(): ToolFunctionSchema[] {
  if (!readOnlyCliSchemas) readOnlyCliSchemas = parseProtocolSchemas(READ_ONLY_TOOL_PROTOCOL);
  return readOnlyCliSchemas;
}
