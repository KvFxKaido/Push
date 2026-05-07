/**
 * Web-side dispatch for the `create_artifact` / `artifact` tool.
 *
 * Detects fenced JSON tool calls in the model's output, then POSTs to
 * `/api/artifacts/create` (handled by `app/src/worker/worker-artifacts.ts`)
 * to validate and persist the record. Returns a `ToolExecutionResult`
 * carrying both the model-facing `text` summary and an inline `card` so
 * the chat renders the artifact next to the assistant message.
 *
 * The Worker route is the source of truth for validation — this module
 * forwards args verbatim and surfaces structured errors back to the
 * model. Keeping the validation single-sided avoids the CLI/web rules
 * drifting (the CLI executor calls `validateCreateArtifactArgs` directly;
 * the web Worker does the same on the route).
 */

import { resolveToolName } from '@push/lib/tool-registry';
import type {
  ArtifactAuthor,
  ArtifactRecord,
  ArtifactScope,
  CreateArtifactArgs,
} from '@push/lib/artifacts/types';
import { isArtifactKind } from '@push/lib/artifacts/types';
import type { StructuredToolError, ToolExecutionResult } from '@/types';
import { resolveApiUrl } from './api-url';
import { detectToolFromText } from './utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArtifactToolCall {
  tool: 'create_artifact';
  args: CreateArtifactArgs;
}

const CREATE_ARTIFACT_URL = resolveApiUrl('/api/artifacts/create');

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect a `create_artifact` (or aliased `artifact`) tool call in model
 * output. Performs a minimal shape check — full validation happens on
 * the Worker route so a single source of truth gates persistence.
 */
export function detectArtifactToolCall(text: string): ArtifactToolCall | null {
  return detectToolFromText<ArtifactToolCall>(text, (parsed) => {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (resolveToolName(typeof obj.tool === 'string' ? obj.tool : '') !== 'create_artifact') {
      return null;
    }
    const args = obj.args;
    if (typeof args !== 'object' || args === null) return null;
    const argRec = args as Record<string, unknown>;
    if (!isArtifactKind(argRec.kind)) return null;
    if (typeof argRec.title !== 'string' || argRec.title.trim().length === 0) return null;
    // The Worker re-validates everything; we just confirm the call is
    // unambiguously an artifact request before claiming the turn.
    return { tool: 'create_artifact', args: args as unknown as CreateArtifactArgs };
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ArtifactCreateSuccess {
  ok: true;
  record: ArtifactRecord;
  summary: string;
}

interface ArtifactCreateFailure {
  ok: false;
  code: string;
  field?: string;
  message: string;
}

type ArtifactCreateResponse = ArtifactCreateSuccess | ArtifactCreateFailure;

function isCreateResponse(value: unknown): value is ArtifactCreateResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === 'boolean';
}

/**
 * POST `args` + `scope` + `author` to `/api/artifacts/create` and shape
 * the result into a `ToolExecutionResult`. Network/transport failures
 * map to retryable structured errors so the model can correct on the
 * next round; validation errors from the Worker (400s) are non-retryable
 * because retrying the same payload will fail identically.
 */
export async function executeArtifactToolCall(
  args: CreateArtifactArgs,
  scope: ArtifactScope,
  author: ArtifactAuthor,
): Promise<ToolExecutionResult> {
  let response: Response;
  try {
    response = await fetch(CREATE_ARTIFACT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args, scope, author }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const structuredError: StructuredToolError = {
      type: 'UNKNOWN',
      retryable: true,
      message: `Artifact create failed: ${message}`,
      detail: 'NETWORK',
    };
    return {
      text: `[Tool Error] ${structuredError.message}`,
      structuredError,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const structuredError: StructuredToolError = {
      type: 'UNKNOWN',
      retryable: true,
      message: `Artifact create returned non-JSON response (status ${response.status}): ${message}`,
      detail: 'BAD_RESPONSE',
    };
    return {
      text: `[Tool Error] ${structuredError.message}`,
      structuredError,
    };
  }

  if (!isCreateResponse(body)) {
    const structuredError: StructuredToolError = {
      type: 'UNKNOWN',
      retryable: true,
      message: `Artifact create returned an unexpected payload (status ${response.status}).`,
      detail: 'BAD_RESPONSE',
    };
    return {
      text: `[Tool Error] ${structuredError.message}`,
      structuredError,
    };
  }

  if (!body.ok) {
    // 5xx is retryable in principle — the operator may bind ARTIFACTS
    // KV (NOT_CONFIGURED) or recover from a transient persist failure
    // and the next call will succeed. 4xx maps to INVALID_ARG and is
    // non-retryable: the same payload will fail validation identically.
    const retryable = response.status >= 500;
    const fieldDetail = body.field ? ` (field: ${body.field})` : '';
    const structuredError: StructuredToolError = {
      type: retryable ? 'UNKNOWN' : 'INVALID_ARG',
      retryable,
      message: `${body.message}${fieldDetail}`,
      detail: body.code,
    };
    return {
      text: `[Tool Error] Cannot create artifact (${body.code}): ${body.message}${fieldDetail}`,
      structuredError,
    };
  }

  return {
    text: body.summary,
    card: { type: 'artifact', data: { record: body.record } },
  };
}
