/**
 * Scope OpenRouter's all-or-nothing `provider.require_parameters` filter to
 * parameters that Push actually needs the routed endpoint to honor.
 *
 * OpenRouter applies the flag to every LLM parameter present in the request.
 * `tool_choice: 'auto'` is redundant with the API default. Keeping it in a
 * constrained request can exclude an endpoint that supports tools but does not
 * advertise the optional selector. Explicit sampling values are different:
 * Push and its callers chose them, so this helper preserves them.
 *
 * Resource/behavior constraints (`max_tokens`, sampling, reasoning, tools,
 * forced tool choice, and structured output) deliberately remain in the body.
 */

import { isOpenRouterRoutingConstraintBody } from './responses-chat-fallback.js';

export const OPENROUTER_PARAMETER_EVENTS = {
  structuredOutputRelaxed: 'openrouter_structured_output_relaxed',
} as const;

export type OpenRouterWireTransport = 'responses' | 'chat';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function scopeOpenRouterRequiredParameters(
  body: Record<string, unknown>,
  requireParameters: boolean,
): Record<string, unknown> {
  if (!requireParameters) return body;

  const scoped = { ...body };
  if (scoped.tool_choice === 'auto') delete scoped.tool_choice;

  const existingProvider = asRecord(body.provider);
  scoped.provider = {
    ...(existingProvider ?? {}),
    require_parameters: true,
  };
  return scoped;
}

/**
 * Remove only the native structured-output field after OpenRouter has proved
 * that no endpoint can honor the full parameter set. Role prompts still request
 * JSON and callers still validate it, so this restores the existing prompt-only
 * fallback instead of failing the turn.
 *
 * Native tools remain hard when present. A schema-only request no longer needs
 * `require_parameters` after the schema is removed, so the provider guard is
 * removed as well and normal routing can resume.
 */
export function relaxOpenRouterStructuredOutput(
  body: Record<string, unknown>,
  transport: OpenRouterWireTransport,
  requireParametersAfterRelaxation: boolean,
): Record<string, unknown> | null {
  const relaxed = { ...body };

  if (transport === 'chat') {
    if (!Object.hasOwn(body, 'response_format')) return null;
    delete relaxed.response_format;
  } else {
    const text = asRecord(body.text);
    if (!text || !Object.hasOwn(text, 'format')) return null;
    const { format: _format, ...remainingText } = text;
    if (Object.keys(remainingText).length > 0) relaxed.text = remainingText;
    else delete relaxed.text;
  }

  const existingProvider = asRecord(relaxed.provider);
  if (requireParametersAfterRelaxation) {
    relaxed.provider = {
      ...(existingProvider ?? {}),
      require_parameters: true,
    };
  } else if (existingProvider) {
    const { require_parameters: _requireParameters, ...remainingProvider } = existingProvider;
    if (Object.keys(remainingProvider).length > 0) relaxed.provider = remainingProvider;
    else delete relaxed.provider;
  }

  return relaxed;
}

interface OpenRouterResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface OpenRouterStructuredOutputFetchResult<TResponse> {
  response: TResponse;
  /** Already consumed from a non-2xx response; null for success. */
  errorBody: string | null;
  relaxedStructuredOutput: boolean;
}

/**
 * Attempt an OpenRouter request once as specified. Only a producer-classified
 * routing-constraint rejection may trigger one adjusted retry, and that retry
 * removes only native structured output. Working requests therefore keep their
 * schema and sampling byte-for-byte.
 */
export async function fetchOpenRouterWithStructuredOutputFallback<
  TResponse extends OpenRouterResponseLike,
>(options: {
  body: Record<string, unknown>;
  transport: OpenRouterWireTransport;
  requireParameters: boolean;
  requireParametersAfterRelaxation: boolean;
  attempt: (body: Record<string, unknown>) => Promise<TResponse>;
  onRelaxed?: () => void;
}): Promise<OpenRouterStructuredOutputFetchResult<TResponse>> {
  const firstResponse = await options.attempt(options.body);
  if (firstResponse.ok) {
    return {
      response: firstResponse,
      errorBody: null,
      relaxedStructuredOutput: false,
    };
  }

  const firstErrorBody = await firstResponse.text().catch(() => '');
  if (
    firstResponse.status !== 404 ||
    !options.requireParameters ||
    !isOpenRouterRoutingConstraintBody(firstErrorBody)
  ) {
    return {
      response: firstResponse,
      errorBody: firstErrorBody,
      relaxedStructuredOutput: false,
    };
  }

  const relaxedBody = relaxOpenRouterStructuredOutput(
    options.body,
    options.transport,
    options.requireParametersAfterRelaxation,
  );
  if (!relaxedBody) {
    return {
      response: firstResponse,
      errorBody: firstErrorBody,
      relaxedStructuredOutput: false,
    };
  }

  options.onRelaxed?.();
  const relaxedResponse = await options.attempt(relaxedBody);
  return {
    response: relaxedResponse,
    errorBody: relaxedResponse.ok ? null : await relaxedResponse.text().catch(() => ''),
    relaxedStructuredOutput: true,
  };
}
