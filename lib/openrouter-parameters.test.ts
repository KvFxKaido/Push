import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_PARAMETER_EVENTS,
  fetchOpenRouterWithStructuredOutputFallback,
  relaxOpenRouterStructuredOutput,
  scopeOpenRouterRequiredParameters,
} from './openrouter-parameters.js';

const ROUTING_CONSTRAINT_BODY =
  '{"error":{"message":"No endpoints found that can handle the requested parameters"}}';

function response(
  ok: boolean,
  body = '',
  status = ok ? 200 : 404,
): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok, status, text: async () => body };
}

it('pins the shared structured-output relaxation event name', () => {
  expect(OPENROUTER_PARAMETER_EVENTS).toEqual({
    structuredOutputRelaxed: 'openrouter_structured_output_relaxed',
  });
});

describe('scopeOpenRouterRequiredParameters', () => {
  it('leaves unconstrained requests byte-shape compatible', () => {
    const body = { temperature: 0.7, top_p: 0.9, max_tokens: 4096 };

    expect(scopeOpenRouterRequiredParameters(body, false)).toBe(body);
  });

  it('preserves sampling while omitting redundant auto tool choice', () => {
    const body = {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096,
      reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'read_file' }],
      tool_choice: 'auto',
      response_format: { type: 'json_schema' },
      provider: { sort: 'throughput' },
    };

    expect(scopeOpenRouterRequiredParameters(body, true)).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096,
      reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'read_file' }],
      response_format: { type: 'json_schema' },
      provider: { sort: 'throughput', require_parameters: true },
    });
    expect(body).toMatchObject({ temperature: 0.7, top_p: 0.9, tool_choice: 'auto' });
  });

  it('keeps a forced tool choice as a real behavior constraint', () => {
    expect(
      scopeOpenRouterRequiredParameters(
        { tools: [{ type: 'function', name: 'read_file' }], tool_choice: 'required' },
        true,
      ),
    ).toMatchObject({
      tool_choice: 'required',
      provider: { require_parameters: true },
    });
  });
});

describe('relaxOpenRouterStructuredOutput', () => {
  it('drops Chat structured output but keeps sampling and a native-tool guard', () => {
    expect(
      relaxOpenRouterStructuredOutput(
        {
          temperature: 1,
          top_p: 0.95,
          tools: [{ type: 'function' }],
          response_format: { type: 'json_schema' },
          provider: { require_parameters: true },
        },
        'chat',
        true,
      ),
    ).toEqual({
      temperature: 1,
      top_p: 0.95,
      tools: [{ type: 'function' }],
      provider: { require_parameters: true },
    });
  });

  it('drops only Responses text.format and removes an obsolete schema-only guard', () => {
    expect(
      relaxOpenRouterStructuredOutput(
        {
          text: { format: { type: 'json_schema' }, verbosity: 'low' },
          provider: { require_parameters: true, sort: 'throughput' },
        },
        'responses',
        false,
      ),
    ).toEqual({
      text: { verbosity: 'low' },
      provider: { sort: 'throughput' },
    });
  });
});

describe('fetchOpenRouterWithStructuredOutputFallback', () => {
  it('retries a routing rejection once with structured output relaxed', async () => {
    const attemptedBodies: Record<string, unknown>[] = [];
    let attempts = 0;
    let relaxedLogs = 0;

    const result = await fetchOpenRouterWithStructuredOutputFallback({
      body: {
        text: { format: { type: 'json_schema' } },
        temperature: 0.1,
        provider: { require_parameters: true },
      },
      transport: 'responses',
      requireParameters: true,
      requireParametersAfterRelaxation: false,
      attempt: async (body) => {
        attemptedBodies.push(body);
        attempts += 1;
        return attempts === 1 ? response(false, ROUTING_CONSTRAINT_BODY) : response(true);
      },
      onRelaxed: () => {
        relaxedLogs += 1;
      },
    });

    expect(result).toMatchObject({
      errorBody: null,
      relaxedStructuredOutput: true,
    });
    expect(attemptedBodies).toEqual([
      {
        text: { format: { type: 'json_schema' } },
        temperature: 0.1,
        provider: { require_parameters: true },
      },
      { temperature: 0.1 },
    ]);
    expect(relaxedLogs).toBe(1);
  });

  it('does not relax a non-routing failure', async () => {
    const attempt = async () => response(false, '{"error":"rate limited"}');
    const result = await fetchOpenRouterWithStructuredOutputFallback({
      body: {
        response_format: { type: 'json_schema' },
        provider: { require_parameters: true },
      },
      transport: 'chat',
      requireParameters: true,
      requireParametersAfterRelaxation: false,
      attempt,
    });

    expect(result.relaxedStructuredOutput).toBe(false);
    expect(result.errorBody).toContain('rate limited');
  });

  it('does not relax a non-404 response that reuses the routing message', async () => {
    let attempts = 0;
    const result = await fetchOpenRouterWithStructuredOutputFallback({
      body: {
        response_format: { type: 'json_schema' },
        provider: { require_parameters: true },
      },
      transport: 'chat',
      requireParameters: true,
      requireParametersAfterRelaxation: false,
      attempt: async () => {
        attempts += 1;
        return response(false, ROUTING_CONSTRAINT_BODY, 500);
      },
    });

    expect(attempts).toBe(1);
    expect(result.relaxedStructuredOutput).toBe(false);
  });
});
