import { describe, expect, it } from 'vitest';

import type { LlmMessage, LlmToolResultBlock, LlmToolUseBlock } from './provider-contract.ts';
import {
  deriveContentBlocks,
  materializeToolContentBlocks,
  withContentBlocks,
} from './content-blocks.ts';

const msg = (extra: Partial<LlmMessage>): LlmMessage => ({
  id: '1',
  role: 'user',
  content: '',
  timestamp: 0,
  ...extra,
});

const sidecarMsg = (
  extra: Partial<LlmMessage> & {
    toolUses?: LlmToolUseBlock[];
    toolResults?: LlmToolResultBlock[];
  },
): LlmMessage & { toolUses?: LlmToolUseBlock[]; toolResults?: LlmToolResultBlock[] } => ({
  ...msg(extra),
  ...(extra.toolUses ? { toolUses: extra.toolUses } : {}),
  ...(extra.toolResults ? { toolResults: extra.toolResults } : {}),
});

describe('deriveContentBlocks', () => {
  it('wraps a plain string content as a single text block', () => {
    expect(deriveContentBlocks(msg({ content: 'hello' }))).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('maps contentParts (text + data/url images) to text/image blocks', () => {
    expect(
      deriveContentBlocks(
        msg({
          content: 'fallback',
          contentParts: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
    ]);
  });

  it('prepends signed reasoning blocks (Anthropic ordering) and carries cache_control', () => {
    expect(
      deriveContentBlocks(
        msg({
          role: 'assistant',
          reasoningBlocks: [{ type: 'thinking', text: 'hmm', signature: 's' }],
          contentParts: [{ type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } }],
        }),
      ),
    ).toEqual([
      { type: 'thinking', text: 'hmm', signature: 's' },
      { type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('returns [] for an empty turn', () => {
    expect(deriveContentBlocks(msg({ content: '' }))).toEqual([]);
  });

  it('throws on a malformed image part (missing url) and an unrepresentable url', () => {
    expect(() =>
      deriveContentBlocks(
        msg({ contentParts: [{ type: 'image_url', image_url: {} }] as LlmMessage['contentParts'] }),
      ),
    ).toThrow(/unsupported or malformed content part/);
    expect(() =>
      deriveContentBlocks(
        msg({ contentParts: [{ type: 'image_url', image_url: { url: 'ftp://x/y.png' } }] }),
      ),
    ).toThrow(/unsupported or malformed content part/);
  });

  it('throws on an unknown part type rather than silently dropping it (loud-fail parity)', () => {
    expect(() =>
      deriveContentBlocks(
        msg({
          contentParts: [
            { type: 'text', text: 'ok' },
            { type: 'audio' },
          ] as unknown as LlmMessage['contentParts'],
        }),
      ),
    ).toThrow(/unsupported or malformed content part/);
  });
});

describe('withContentBlocks', () => {
  it('materializes contentBlocks for a multimodal (contentParts) turn', () => {
    const out = withContentBlocks(msg({ contentParts: [{ type: 'text', text: 'hi' }] }));
    expect(out.contentBlocks).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('leaves a plain-text turn untouched (no contentBlocks added)', () => {
    const input = msg({ content: 'just text' });
    expect(withContentBlocks(input)).toBe(input);
  });

  it('leaves a reasoning-only turn (no contentParts) untouched — stays byte-identical via the sidecar', () => {
    const input = msg({
      role: 'assistant',
      content: 'because',
      reasoningBlocks: [{ type: 'thinking', text: 't', signature: 's' }],
    });
    expect(withContentBlocks(input).contentBlocks).toBeUndefined();
  });

  it('is idempotent when contentBlocks already present', () => {
    const input = msg({ contentBlocks: [{ type: 'text', text: 'pre' }] });
    expect(withContentBlocks(input)).toBe(input);
  });
});

describe('materializeToolContentBlocks', () => {
  it('maps paired tool sidecars to contentBlocks without mutating the legacy content text', () => {
    const toolUse: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_read_1',
      name: 'read_file',
      input: { path: 'README.md' },
    };
    const toolResult: LlmToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: '[meta] round=1\nfile body',
    };

    const out = materializeToolContentBlocks([
      sidecarMsg({
        id: 'a1',
        role: 'assistant',
        content: '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```',
        reasoningBlocks: [{ type: 'thinking', text: 'need file', signature: 'sig' }],
        toolUses: [toolUse],
      }),
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] file body [/TOOL_RESULT]',
        toolResults: [toolResult],
      }),
    ]);

    expect(out[0].content).toContain('read_file');
    expect(out[0].contentBlocks).toEqual([
      { type: 'thinking', text: 'need file', signature: 'sig' },
      toolUse,
    ]);
    expect(out[1].contentBlocks).toEqual([toolResult]);
  });

  it('keeps an orphan tool_result on the text fallback', () => {
    const out = materializeToolContentBlocks([
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] late body [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: 'missing', content: 'late body' }],
      }),
    ]);

    expect(out[0].contentBlocks).toBeUndefined();
  });

  it('degrades a batched assistant turn when any tool_use lacks a result', () => {
    const first: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_first',
      name: 'read_file',
      input: { path: 'a.ts' },
    };
    const orphan: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_second',
      name: 'write_file',
      input: { path: 'b.ts', content: 'x' },
    };

    const out = materializeToolContentBlocks([
      sidecarMsg({
        id: 'a1',
        role: 'assistant',
        content: '```json\n[{"tool":"read_file"},{"tool":"write_file"}]\n```',
        toolUses: [first, orphan],
      }),
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] first body [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: first.id, content: 'first body' }],
      }),
    ]);

    expect(out[0].contentBlocks).toBeUndefined();
    expect(out[1].contentBlocks).toBeUndefined();
  });

  // Adjacency regression (Codex review). Anthropic requires a tool_use to be
  // answered in the immediately-following user turn(s). Push's parallel-read
  // batch lands ONE assistant turn carrying N tool_use blocks, then N *separate*
  // consecutive result messages (one block each — Anthropic coalesces the
  // consecutive user turns, same as the text arm already relies on). The
  // materializer is structure-preserving, so it must emit: the assistant
  // tool_use turn first, then each result turn directly after, in order, with no
  // message reordered/inserted/dropped — i.e. adjacency is inherited from the
  // input ordering, not broken by materialization.
  it('preserves assistant→result adjacency and ordering for a parallel batch', () => {
    const useA: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_a',
      name: 'read_file',
      input: { path: 'a.ts' },
    };
    const useB: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_b',
      name: 'read_file',
      input: { path: 'b.ts' },
    };
    const resA: LlmToolResultBlock = { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' };
    const resB: LlmToolResultBlock = { type: 'tool_result', tool_use_id: 'toolu_b', content: 'B' };

    const input = [
      sidecarMsg({ id: 'a1', role: 'assistant', content: 'fenced', toolUses: [useA, useB] }),
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] A [/TOOL_RESULT]',
        toolResults: [resA],
      }),
      sidecarMsg({
        id: 'r2',
        role: 'user',
        content: '[TOOL_RESULT] B [/TOOL_RESULT]',
        toolResults: [resB],
      }),
    ];
    const out = materializeToolContentBlocks(input);

    // Structure-preserving: same count, same ids, same roles, same order.
    expect(out.map((m) => m.id)).toEqual(['a1', 'r1', 'r2']);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'user']);

    // The assistant turn carries BOTH tool_use blocks; each result turn leads
    // with its single tool_result and references a use from the prior assistant
    // turn — so the coalesced user turn answers every tool_use immediately after.
    expect(out[0].contentBlocks).toEqual([useA, useB]);
    expect(out[1].contentBlocks).toEqual([resA]);
    expect(out[2].contentBlocks).toEqual([resB]);
    const useIds = (out[0].contentBlocks ?? [])
      .filter((b): b is LlmToolUseBlock => b.type === 'tool_use')
      .map((b) => b.id);
    const resultRefs = [out[1], out[2]].flatMap((m) =>
      (m.contentBlocks ?? [])
        .filter((b): b is LlmToolResultBlock => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    expect(new Set(resultRefs)).toEqual(new Set(useIds));
  });

  // Codex P1 (PR #1159). transformContextBeforeLLM can splice a synthetic
  // goal/session-digest *user* message between the assistant tool-call turn and
  // its tool_result, giving assistant(tool_use), user(digest), user(tool_result).
  // The result is "later" but NOT adjacent — Anthropic/OpenAI reject a non-result
  // message between a tool_use and its tool_result. The whole exchange must
  // degrade to the text arm.
  it('degrades when a non-result message is spliced between tool_use and tool_result', () => {
    const use: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_x',
      name: 'read_file',
      input: { path: 'x.ts' },
    };
    const out = materializeToolContentBlocks([
      sidecarMsg({ id: 'a1', role: 'assistant', content: 'fenced', toolUses: [use] }),
      // Synthetic digest/goal-anchor turn injected by the context transformer —
      // a user message with NO tool_results.
      sidecarMsg({ id: 'digest', role: 'user', content: '[SESSION_DIGEST] ...' }),
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] x [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: use.id, content: 'x' }],
      }),
    ]);

    expect(out[0].contentBlocks).toBeUndefined();
    expect(out[1].contentBlocks).toBeUndefined();
    expect(out[2].contentBlocks).toBeUndefined();
  });

  // Adjacency is validity-aware: an intervening message that IS a tool_result
  // turn but whose own pair is invalid (so it degrades to text) also breaks
  // adjacency for a later result.
  it('degrades when an intervening result message is itself unpaired (degrades to text)', () => {
    const use: LlmToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_real',
      name: 'read_file',
      input: { path: 'r.ts' },
    };
    const out = materializeToolContentBlocks([
      sidecarMsg({ id: 'a1', role: 'assistant', content: 'fenced', toolUses: [use] }),
      // Orphan result (no matching tool_use) — degrades to text, so it can't sit
      // between `use` and its real result as a valid block turn.
      sidecarMsg({
        id: 'orphan',
        role: 'user',
        content: '[TOOL_RESULT] orphan [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'orphan' }],
      }),
      sidecarMsg({
        id: 'r1',
        role: 'user',
        content: '[TOOL_RESULT] real [/TOOL_RESULT]',
        toolResults: [{ type: 'tool_result', tool_use_id: use.id, content: 'real' }],
      }),
    ]);

    expect(out[0].contentBlocks).toBeUndefined();
    expect(out[1].contentBlocks).toBeUndefined();
    expect(out[2].contentBlocks).toBeUndefined();
  });
});
