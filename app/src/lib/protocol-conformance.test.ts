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
import { STRUCTURED_OUTPUT_TOOL_NAME, toAnthropicMessages } from '@push/lib/anthropic-bridge';
import { toGeminiGenerateContent } from '@push/lib/gemini-bridge';
import { toOpenAIChat } from '@push/lib/openai-chat-serializer';
import { resolvePushCapabilityProfile } from './model-catalog';
import { routeReplaysReasoningContent } from './orchestrator-provider-routing';

/**
 * Provider-native conformance harness — issue #1169.
 *
 * This file is the *dual* of `PushCapabilityProfile`. The profile declares what
 * a (provider, model) route promises; each column suite proves the provider
 * serializer/parser actually delivers it. Two structural invariants make the
 * harness self-enforcing rather than decorative:
 *
 *   1. Drift gate — every capability column must be EITHER executably covered
 *      (`conformanceColumn(...)` with real assertions) OR on the explicit
 *      `PENDING_COLUMNS` backlog. A new column with neither fails CI, and a
 *      TODO placeholder can't masquerade as covered (Vitest treats `it.todo` as
 *      non-failing) — see the drift-gate test at the bottom.
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
 * Status: `toolCalling`, `structuredOutput`, and `reasoningBlocks` are
 * executably covered. `streamingTools`, `multimodal`, `contentBlocks`, and
 * `context` sit on the explicit `PENDING_COLUMNS` backlog (visible `it.todo`s,
 * not counted as covered) until their fill-in lands; tracked on #1169.
 * `multimodal` additionally has real (non-gate-registered) delivery + model-
 * axis coverage in a plain `describe` — see the block above the pending list
 * for why that doesn't close the column yet.
 */

// --- drift-gate registration -------------------------------------------------
type ConformanceColumn = keyof PushCapabilityProfile;

// Columns backed by *executable* parity assertions. Only these count as covered.
// `it.todo` placeholders deliberately do NOT land here (see PENDING_COLUMNS), so
// a column can't masquerade as covered with zero assertions — Vitest treats
// `it.todo` as non-failing, which would otherwise hollow out the gate.
const EXECUTABLE_COLUMNS = new Set<ConformanceColumn>();

/** Register a column backed by executable parity assertions. */
function conformanceColumn(column: ConformanceColumn, define: () => void): void {
  EXECUTABLE_COLUMNS.add(column);
  describe(`conformance · ${column}`, define);
}

/**
 * Explicit, reviewable backlog: capability columns with no parity assertion yet.
 * The drift gate requires every profile column to be EITHER executable OR listed
 * here, and the two to be disjoint. Consequence: adding a column with only a
 * TODO forces a deliberate edit to this list — it can't silently ride in as
 * "covered" — and filling a column forces moving it out of here into executable
 * coverage (the overlap check fails otherwise). Addresses the #1186 P2.
 */
const PENDING_COLUMNS = new Set<ConformanceColumn>([
  'streamingTools',
  'multimodal',
  'contentBlocks',
  'context',
]);

/** Render a pending column's owed assertion as a visible `it.todo`. Does NOT
 *  register executable coverage — the gate accounts for it via PENDING_COLUMNS. */
function pendingColumn(column: ConformanceColumn, owedAssertion: string): void {
  describe(`conformance · ${column} (pending)`, () => {
    it.todo(owedAssertion);
  });
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

  it('strict tier (Gemini) → native responseSchema + JSON mime type', () => {
    expect(resolvePushCapabilityProfile('google', 'gemini-3.1-pro-preview').structuredOutput).toBe(
      'strict',
    );
    const body = toGeminiGenerateContent(withFormat('google', 'gemini-3.1-pro-preview')) as {
      generationConfig?: { responseMimeType?: string; responseSchema?: { type?: string } };
    };
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    expect(body.generationConfig?.responseSchema?.type).toBe('OBJECT');
  });
});

// === reasoningBlocks / reasoning replay ====================================
// Signed reasoning blocks remain Anthropic-transport only. DeepSeek thinking
// mode is a separate plain-text replay contract (`reasoning_content`) that is
// route-gated above the shared OpenAI serializer.
conformanceColumn('reasoningBlocks', () => {
  it('signed tier (Anthropic) prepends reasoning blocks before visible text', () => {
    expect(resolvePushCapabilityProfile('anthropic', 'claude-opus-4-7').reasoningBlocks).toBe(true);
    const body = toAnthropicMessages(
      req('anthropic', 'claude-opus-4-7', {
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'visible answer',
            timestamp: 0,
            reasoningBlocks: [{ type: 'thinking', text: 'signed thought', signature: 'sig' }],
          },
        ],
      }),
    ) as { messages: Array<{ role?: string; content?: Array<Record<string, unknown>> }> };

    expect(body.messages[0]?.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'signed thought',
      signature: 'sig',
    });
    expect(body.messages[0]?.content?.[1]).toEqual({ type: 'text', text: 'visible answer' });
  });

  it('DeepSeek on OpenAI-compatible gateways uses plain reasoning_content replay, not signed reasoningBlocks', () => {
    const model = 'deepseek-v4-pro';
    expect(resolvePushCapabilityProfile('zen', model).reasoningBlocks).toBe(false);
    expect(routeReplaysReasoningContent('zen', model)).toBe(true);
    expect(routeReplaysReasoningContent('openrouter', 'deepseek/deepseek-r1')).toBe(true);
    const body = toOpenAIChat(
      req('zen', model, {
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'visible answer',
            timestamp: 0,
            reasoningContent: 'plain DeepSeek thought',
          },
        ],
      }),
    );

    expect(body.messages?.[0]).toEqual({
      role: 'assistant',
      content: 'visible answer',
      reasoning_content: 'plain DeepSeek thought',
    });
  });
});

// === multimodal (delivery + model axis proven; degrade path still pending) ===
// Native multimodal routes (Anthropic, Gemini) translate an image content part
// into their provider-native block shape. Support is also a MODEL axis within
// a provider — `modelSupportsMultimodal` resolves per (provider, model), not
// as a blanket per-provider constant (an OpenAI vision model vs. a text-only
// one) — matching the model-axis principle the `structuredOutput` column
// established. Ported from the existing `toAnthropicMessages`/
// `toGeminiGenerateContent` multimodal-contentParts suites.
//
// This is a plain `describe`, NOT `conformanceColumn` — it does not close the
// `multimodal` column (still in PENDING_COLUMNS below). Codex review on this
// PR (#1292) caught that the owed assertion has a second half — "text-only
// routes degrade clearly" — that isn't actually implemented anywhere:
// `multimodal` is never consulted as a gate, so a route resolved
// multimodal:false still gets the image serialized and sent with no clear
// failure mode. Pinning "no gate exists" (below) documents that gap; it is
// not the same as proving "degrades clearly", so it doesn't earn the column.
describe('conformance · multimodal (delivery + model axis; degrade path pending)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const withImage = (provider: string, model: string) =>
    req(provider, model, {
      messages: [
        {
          id: 'a1',
          role: 'user',
          content: 'see image',
          timestamp: 0,
          contentParts: [
            { type: 'text', text: 'see image' },
            { type: 'image_url', image_url: { url: PNG } },
          ],
        },
      ],
    });

  it('multimodal-tier Anthropic serializes the image as a base64 source block', () => {
    expect(resolvePushCapabilityProfile('anthropic', 'claude-opus-4-7').multimodal).toBe(true);
    const body = toAnthropicMessages(withImage('anthropic', 'claude-opus-4-7')) as {
      messages: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('multimodal-tier Gemini serializes the image as inline_data', () => {
    expect(resolvePushCapabilityProfile('google', 'gemini-3.1-pro-preview').multimodal).toBe(true);
    const body = toGeminiGenerateContent(withImage('google', 'gemini-3.1-pro-preview')) as {
      contents: Array<{ parts?: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]?.parts).toContainEqual({
      inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('resolves multimodal per model within one provider, not a blanket true/false', () => {
    expect(resolvePushCapabilityProfile('openai', 'gpt-4o').multimodal).toBe(true);
    expect(resolvePushCapabilityProfile('openai', 'gpt-3.5-turbo').multimodal).toBe(false);
  });

  it('documents the gap: a route resolved multimodal:false still gets the image passed through, unfiltered', () => {
    // NOT "degrades clearly" — this is "doesn't degrade at all". The image is
    // serialized and sent as-is; whether the provider API then rejects it is
    // outside Push's control. Kept as a plain `describe` (not
    // `conformanceColumn`) specifically so the drift gate still demands a
    // real decision — add gating, or explicitly ratify passthrough-by-design
    // — before `multimodal` can be marked covered.
    const body = toOpenAIChat(withImage('openai', 'gpt-3.5-turbo'));
    expect(body.messages?.[0]?.content).toContainEqual({
      type: 'image_url',
      image_url: { url: PNG },
    });
  });
});

// === remaining columns: explicit pending placeholders ========================
// Visible `it.todo` backlog. These do NOT count as covered — the gate accounts
// for them via PENDING_COLUMNS, so they can't masquerade as parity assertions.
// Filling a column means real `conformanceColumn(...)` assertions AND removing
// it from PENDING_COLUMNS. Most have existing bridge-test coverage to port in.
pendingColumn(
  'streamingTools',
  'native tool-call fragments accumulate incrementally + flush per route that advertises it',
);
pendingColumn(
  'multimodal',
  'text-only routes (multimodal:false) gate or clearly degrade image content instead of passing it through unfiltered — delivery to multimodal-tier routes and the per-model resolution axis are already proven in the plain `describe` block above, not registered as covered pending this decision',
);
pendingColumn(
  'contentBlocks',
  'contentBlocks:true routes consume LlmMessage.contentBlocks; legacy/text routes preserve the text fallback',
);
pendingColumn(
  'context',
  'context tier resolves stably (small/medium/large) from the catalog limit for UI + degradation decisions',
);

// === the keystone: drift gate ================================================
describe('protocol conformance · drift gate', () => {
  it('every column is executably covered or explicitly pending (and the two are disjoint)', () => {
    const columns = Object.keys(DEFAULT_PUSH_CAPABILITY_PROFILE) as ConformanceColumn[];

    // A column can't be both proven and pending — filling one means moving it.
    const overlap = [...EXECUTABLE_COLUMNS].filter((column) => PENDING_COLUMNS.has(column));
    expect(
      overlap,
      `columns both executable and pending: ${overlap.join(', ') || '(none)'}`,
    ).toEqual([]);

    // Self-enforcement: every profile column must be accounted for. A new column
    // with neither executable assertions nor an explicit pending entry fails here.
    const accounted = new Set<ConformanceColumn>([...EXECUTABLE_COLUMNS, ...PENDING_COLUMNS]);
    const missing = columns.filter((column) => !accounted.has(column));
    expect(
      missing,
      `columns with no executable suite and no pending entry: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);

    // No stale pending entries (a filled or removed column left behind).
    const realColumns = new Set<string>(columns);
    const stalePending = [...PENDING_COLUMNS].filter((column) => !realColumns.has(column));
    expect(
      stalePending,
      `PENDING_COLUMNS entries that are not real profile columns: ${stalePending.join(', ') || '(none)'}`,
    ).toEqual([]);
  });
});
