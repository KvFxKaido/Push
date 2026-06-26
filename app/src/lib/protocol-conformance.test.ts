import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUSH_CAPABILITY_PROFILE,
  type PushCapabilityProfile,
} from '@push/lib/capabilities';
import type {
  LlmMessage,
  PushStreamRequest,
  ToolFunctionSchema,
} from '@push/lib/provider-contract';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  toAnthropicMessages,
} from '@push/lib/openai-anthropic-bridge';
import { toGeminiGenerateContent } from '@push/lib/openai-gemini-bridge';
import { resolvePushCapabilityProfile } from './model-catalog';

/**
 * Provider-native conformance harness — issue #1169.
 *
 * This file is the *dual* of `PushCapabilityProfile`. The profile declares what
 * a (provider, model) route promises; each column suite proves the provider
 * serializer/parser actually delivers it. Two structural invariants make the
 * harness self-enforcing rather than decorative:
 *
 *   1. Drift gate — every capability column MUST register a conformance suite,
 *      so a new column can't ship without a parity assertion. Adding a key to
 *      `PushCapabilityProfile` without a `conformanceColumn(...)` call below
 *      fails CI (see the drift-gate test at the bottom).
 *
 *   2. Model axis — columns whose resolution varies by model *within* a provider
 *      (structuredOutput is the live example: opus-4-7 → native `output_config`,
 *      older 4.0 → forced-tool) assert per-(provider × representative-model-tier),
 *      not per-provider. A per-provider-only matrix greens on the native path
 *      and never exercises the fallback — the exact gap #1169 exists to close.
 *
 * Assertion shape: given a neutral `PushStreamRequest`, assert the serializer
 * delivers exactly what `resolvePushCapabilityProfile(provider, model)` promises
 * for that column. The profile is the contract; the serializer is the proof.
 *
 * Status: skeleton + two exemplar columns (`toolCalling`, `structuredOutput`).
 * The remaining columns are registered as `it.todo` placeholders so the drift
 * gate stays green while the per-column fill-in is tracked on #1169.
 */

// --- drift-gate registration -------------------------------------------------
type ConformanceColumn = keyof PushCapabilityProfile;
const REGISTERED_COLUMNS = new Set<ConformanceColumn>();

/** Register and define a conformance suite for one capability column. The
 *  registration is what the drift gate checks; the body holds the assertions. */
function conformanceColumn(column: ConformanceColumn, define: () => void): void {
  REGISTERED_COLUMNS.add(column);
  describe(`conformance · ${column}`, define);
}

// --- window stub: `resolvePushCapabilityProfile` resolves through the model
//     catalog, which reads localStorage for cached provider catalogs. ----------
function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}
beforeEach(() => {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage: createStorageMock(),
    sessionStorage: createStorageMock(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// --- shared fixtures ---------------------------------------------------------
const userTurn = { id: '1', role: 'user', content: 'go', timestamp: 0 } as LlmMessage;

const readFileTool: ToolFunctionSchema = {
  name: 'sandbox_read_file',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

function req(
  provider: string,
  model: string,
  extra: Partial<PushStreamRequest<LlmMessage>> = {},
): PushStreamRequest<LlmMessage> {
  return { provider, model, messages: [userTurn], ...extra } as PushStreamRequest<LlmMessage>;
}

// === exemplar column: toolCalling ===========================================
// Cross-provider parity: where the profile promises `native`, the serializer
// must emit the provider's native function-tool shape.
conformanceColumn('toolCalling', () => {
  it('native-tier Anthropic emits a flat custom-tool schema', () => {
    expect(resolvePushCapabilityProfile('anthropic', 'claude-opus-4-7').toolCalling).toBe('native');
    const body = toAnthropicMessages(
      req('anthropic', 'claude-opus-4-7', { tools: [readFileTool] }),
    ) as { tools?: Array<{ name?: string; input_schema?: unknown }> };
    expect(body.tools).toContainEqual(
      expect.objectContaining({ name: 'sandbox_read_file', input_schema: expect.any(Object) }),
    );
  });

  it('native-tier Gemini emits a functionDeclaration', () => {
    expect(resolvePushCapabilityProfile('google', 'gemini-3.1-pro-preview').toolCalling).toBe(
      'native',
    );
    const body = toGeminiGenerateContent(
      req('google', 'gemini-3.1-pro-preview', { tools: [readFileTool] }),
    ) as { tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }> };
    expect(body.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('sandbox_read_file');
  });
});

// === exemplar column: structuredOutput (the model-axis demonstrator) =========
// Within one provider (Anthropic), the tier flips by model version, and so must
// the wire feature: strict → native `output_config.format`; best-effort → the
// forced-tool fallback. Proves the harness exercises both, not just native.
conformanceColumn('structuredOutput', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };
  const withFormat = (provider: string, model: string) =>
    req(provider, model, { responseFormat: { name: 'verdict', schema } });

  it('strict tier (Anthropic opus-4-7) → native output_config.format', () => {
    expect(resolvePushCapabilityProfile('anthropic', 'claude-opus-4-7').structuredOutput).toBe(
      'strict',
    );
    const body = toAnthropicMessages(withFormat('anthropic', 'claude-opus-4-7')) as {
      output_config?: unknown;
      tools?: unknown;
    };
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
    expect(body.tools).toBeUndefined();
  });

  it('best-effort tier (older Anthropic 4.0) → forced-tool fallback', () => {
    expect(
      resolvePushCapabilityProfile('anthropic', 'claude-sonnet-4@20250514').structuredOutput,
    ).toBe('best-effort');
    const body = toAnthropicMessages(withFormat('anthropic', 'claude-sonnet-4@20250514')) as {
      output_config?: unknown;
      tools?: Array<{ name?: string }>;
    };
    expect(body.output_config).toBeUndefined();
    expect(body.tools?.[0]?.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
  });
});

// === remaining columns: registered placeholders ==============================
// Registered so the drift gate stays green; the `it.todo` text is the parity
// assertion each column owes. Filling these is the #1169 follow-up work — most
// have existing coverage in the bridge tests to port in, not write fresh.
conformanceColumn('streamingTools', () => {
  it.todo(
    'native tool-call fragments accumulate incrementally + flush per route that advertises it',
  );
});
conformanceColumn('multimodal', () => {
  it.todo(
    'image blocks reach multimodal routes (Gemini inline_data / Anthropic image source); text-only routes degrade clearly',
  );
});
conformanceColumn('contentBlocks', () => {
  it.todo(
    'contentBlocks:true routes consume LlmMessage.contentBlocks; legacy/text routes preserve the text fallback',
  );
});
conformanceColumn('reasoningBlocks', () => {
  it.todo(
    'signed reasoning round-trips verbatim: Anthropic thinking.signature + Gemini part.thoughtSignature, captured→stored→replayed',
  );
});
conformanceColumn('context', () => {
  it.todo(
    'context tier resolves stably (small/medium/large) from the catalog limit for UI + degradation decisions',
  );
});

// === the keystone: drift gate ================================================
describe('protocol conformance · drift gate', () => {
  it('every PushCapabilityProfile column has a registered conformance suite', () => {
    const columns = Object.keys(DEFAULT_PUSH_CAPABILITY_PROFILE) as ConformanceColumn[];
    const missing = columns.filter((column) => !REGISTERED_COLUMNS.has(column));
    expect(
      missing,
      `capability columns missing a conformance suite: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
  });
});
