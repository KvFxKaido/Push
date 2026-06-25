/**
 * Producer flip for the Anthropic-conceptual contract migration (see
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 *
 * Derives the canonical `LlmContentBlock[]` representation from a message's
 * legacy `content` / `contentParts` / `reasoningBlocks` fields, so the
 * serializers run their block path in production rather than the legacy
 * branches.
 *
 * Two cases with different fidelity:
 * - Multimodal turns (`contentParts`): the legacy path already emits an array,
 *   so routing through blocks is lossless / byte-equivalent on the wire.
 * - Tool turns (`toolUses` / `toolResults`): NOT equivalent. The legacy text arm
 *   sent the tool call to Anthropic as fenced JSON inside a `text` block; this
 *   path sends a native `tool_use` / `tool_result` block. That's a deliberate
 *   behavior change (text-dispatch → structured tool history), not a re-encoding.
 *   It also drops assistant prose that accompanied the call — see
 *   `toolBlocksForMessage`, which emits reasoning + tool_use only.
 */

import type {
  LlmContentBlock,
  LlmContentPart,
  LlmImageSource,
  LlmMessage,
  LlmToolResultBlock,
  LlmToolUseBlock,
  ReasoningBlock,
} from './provider-contract.ts';

export interface ToolSidecarMessage {
  role: LlmMessage['role'];
  content: string;
  contentParts?: LlmContentPart[];
  contentBlocks?: LlmContentBlock[];
  reasoningBlocks?: ReasoningBlock[];
  toolUses?: LlmToolUseBlock[];
  toolResults?: LlmToolResultBlock[];
}

/** Split an `image_url.url` into the Anthropic-canonical image source: a
 *  `data:<mime>;base64,<data>` URL becomes a base64 source, an `http(s)` URL a
 *  remote `url` source. Anything else THROWS — preserving the legacy
 *  contentParts paths' loud-fail on an unrepresentable image (so an attachment
 *  is never silently dropped on the wire). */
function imageUrlToSource(url: string): LlmImageSource {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (match) return { type: 'base64', media_type: match[1], data: match[2] };
  if (/^https?:\/\//i.test(url)) return { type: 'url', url };
  throw new Error(
    `toContentBlocks: unsupported or malformed content part (image url must be a data:base64 or http(s) URL): ${url.slice(0, 48)}`,
  );
}

function contentPartToBlock(part: LlmContentPart): LlmContentBlock {
  if (part.type === 'text') {
    return {
      type: 'text',
      text: part.text,
      ...(part.cache_control ? { cache_control: part.cache_control } : {}),
    };
  }
  if (part.type === 'image_url') {
    const url = (part.image_url as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string') {
      throw new Error(
        'toContentBlocks: unsupported or malformed content part (image_url.url missing)',
      );
    }
    return {
      type: 'image',
      source: imageUrlToSource(url),
      ...(part.cache_control ? { cache_control: part.cache_control } : {}),
    };
  }
  // Unknown part type: fail loud rather than silently drop it, matching the
  // legacy strict converters (`llmContentPartsToOpenAI` et al. throw here). A
  // silent skip would let a mixed array install a non-empty `contentBlocks`
  // and bypass the serializers' strict paths — dropping an attachment-like
  // part without notice.
  throw new Error(
    `toContentBlocks: unsupported or malformed content part (type: ${JSON.stringify((part as { type?: unknown }).type)})`,
  );
}

/**
 * Build the canonical `LlmContentBlock[]` for a message from its legacy fields.
 * Signed reasoning leads (Anthropic requires `thinking` blocks first on an
 * assistant turn; the OpenAI/Gemini block paths drop them) — the
 * `ReasoningBlock` shape IS already an `LlmContentBlock`, so it's reused
 * verbatim. Then the rich `contentParts` (text/image) when present, else the
 * `content` text. Returns `[]` for an empty turn, matching the serializers'
 * empty-content fallback.
 */
export function deriveContentBlocks(message: LlmMessage): LlmContentBlock[] {
  const blocks: LlmContentBlock[] = [];
  if (message.reasoningBlocks && message.reasoningBlocks.length > 0) {
    blocks.push(...message.reasoningBlocks);
  }
  if (message.contentParts && message.contentParts.length > 0) {
    for (const part of message.contentParts) {
      blocks.push(contentPartToBlock(part));
    }
  } else if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  return blocks;
}

/**
 * Return `message` with `contentBlocks` populated (deriving them from the legacy
 * fields when absent) — the per-message producer flip. Scoped to multimodal
 * turns (`contentParts` present): there the legacy serializer path already emits
 * an array, so routing through the block path is byte-identical. A plain-text
 * turn keeps its `content` string (and its `reasoningBlocks` sidecar) untouched,
 * which avoids array-ifying string content the legacy path emitted verbatim.
 * Idempotent: a message that already carries `contentBlocks` is unchanged.
 */
export function withContentBlocks(message: LlmMessage): LlmMessage {
  if (message.contentBlocks && message.contentBlocks.length > 0) return message;
  if (!message.contentParts || message.contentParts.length === 0) return message;
  const contentBlocks = deriveContentBlocks(message);
  if (contentBlocks.length === 0) return message;
  return { ...message, contentBlocks };
}

function sidecarIdsForMessage(message: ToolSidecarMessage): string[] {
  const ids: string[] = [];
  if (message.role === 'assistant') {
    for (const block of message.toolUses ?? []) ids.push(block.id);
  }
  if (message.role !== 'assistant') {
    for (const block of message.toolResults ?? []) ids.push(block.tool_use_id);
  }
  return ids;
}

/**
 * Adjacency guard (Codex review, PR #1159). Anthropic/OpenAI require a
 * `tool_use` to be answered in the immediately-following user turn(s) — the API
 * coalesces consecutive `user` turns, but a non-result message between the
 * assistant tool-call turn and its `tool_result` breaks the pair. This is
 * reachable: `transformContextBeforeLLM` can splice a synthetic goal /
 * session-digest *user* message in just before the last message, yielding
 * `assistant(tool_use)`, `user(digest)`, `user(tool_result)`. A use is adjacency-
 * valid for a result only if every message strictly between them is a user
 * message carrying ONLY block-valid tool_results (another result in the same
 * coalesced answer turn) — any assistant turn, or any user message that isn't a
 * pure valid-tool_result message, breaks adjacency and degrades the exchange to
 * the text arm. Validity-aware (checks `validIds`) so it composes with the
 * whole-message fixpoint below: an intervening result that itself degrades to
 * text also breaks adjacency. */
function isAdjacent(
  useIndex: number,
  resultIndex: number,
  messages: readonly ToolSidecarMessage[],
  validIds: ReadonlySet<string>,
): boolean {
  for (let k = useIndex + 1; k < resultIndex; k += 1) {
    const between = messages[k];
    if (between.role === 'assistant') return false;
    const resultIds = (between.toolResults ?? []).map((block) => block.tool_use_id);
    if (resultIds.length === 0) return false;
    if (!resultIds.every((id) => validIds.has(id))) return false;
  }
  return true;
}

function computePairedToolIds(messages: readonly ToolSidecarMessage[]): Set<string> {
  const useIndexById = new Map<string, number>();
  const resultIndexesById = new Map<string, number[]>();

  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const block of message.toolUses ?? []) {
        if (!useIndexById.has(block.id)) useIndexById.set(block.id, index);
      }
      return;
    }
    for (const block of message.toolResults ?? []) {
      const indexes = resultIndexesById.get(block.tool_use_id) ?? [];
      indexes.push(index);
      resultIndexesById.set(block.tool_use_id, indexes);
    }
  });

  let validIds = new Set<string>();
  for (const [id, useIndex] of useIndexById) {
    if ((resultIndexesById.get(id) ?? []).some((resultIndex) => resultIndex > useIndex)) {
      validIds.add(id);
    }
  }

  for (;;) {
    const next = new Set<string>();
    for (const id of validIds) {
      const useIndex = useIndexById.get(id);
      if (useIndex === undefined) continue;
      const useMessageIds = sidecarIdsForMessage(messages[useIndex]);
      if (
        useMessageIds.length === 0 ||
        !useMessageIds.every((messageId) => validIds.has(messageId))
      ) {
        continue;
      }
      const hasValidResult = (resultIndexesById.get(id) ?? []).some((resultIndex) => {
        if (resultIndex <= useIndex) return false;
        if (!isAdjacent(useIndex, resultIndex, messages, validIds)) return false;
        const resultMessageIds = sidecarIdsForMessage(messages[resultIndex]);
        return (
          resultMessageIds.length > 0 &&
          resultMessageIds.every((messageId) => validIds.has(messageId))
        );
      });
      if (hasValidResult) next.add(id);
    }

    if (next.size === validIds.size && [...next].every((id) => validIds.has(id))) {
      return next;
    }
    validIds = next;
  }
}

function toolBlocksForMessage(
  message: ToolSidecarMessage,
  pairedToolIds: ReadonlySet<string>,
): LlmContentBlock[] | undefined {
  if (message.contentBlocks && message.contentBlocks.length > 0) return undefined;

  if (message.role === 'assistant') {
    const toolUses = (message.toolUses ?? [])
      .filter((block) => pairedToolIds.has(block.id))
      .map((block) => ({ ...block }));
    if (toolUses.length === 0 || toolUses.length !== (message.toolUses ?? []).length) {
      return undefined;
    }
    // Behavior change vs the text arm: the assistant turn's `content` (model
    // prose around the call, e.g. "I'll read the file." before the fenced JSON)
    // is NOT carried into the block representation — only signed reasoning and
    // the tool_use blocks are. The structured tool_use is canonical for replay;
    // the prose was display-only narration. Anthropic accepts text before
    // tool_use, so re-including it is possible later if we decide narration
    // should survive replay — today it's intentionally dropped.
    return [...(message.reasoningBlocks ?? []), ...toolUses];
  }

  const toolResults = (message.toolResults ?? [])
    .filter((block) => pairedToolIds.has(block.tool_use_id))
    .map((block) => ({ ...block }));
  if (toolResults.length === 0 || toolResults.length !== (message.toolResults ?? []).length) {
    return undefined;
  }
  return toolResults;
}

/**
 * Map transcript tool sidecars to provider-facing `contentBlocks`, enforcing the
 * Anthropic exchange invariant over the whole request. If a `tool_use` or
 * `tool_result` is missing its counterpart, the entire sidecar-bearing message
 * falls back to the legacy text arm so serializers never see a half-block pair.
 *
 * NOT an identity transform for tool turns. The legacy text arm sends a tool
 * call to Anthropic as a `{ type: 'text' }` block (the fenced JSON verbatim);
 * this path sends a native `tool_use` / `tool_result` block instead — a real
 * behavior change, not a re-encoding of the same wire. Anthropic permits
 * `tool_use`/`tool_result` history without a top-level `tools` definition
 * (relaxed 2025-02-27), so Push's text-dispatch turns (no `req.tools`) serialize
 * fine. The transform is per-message (one in, one out — no reorder/split/drop),
 * but that alone does NOT guarantee Anthropic's tool_use→tool_result adjacency:
 * the text arm imposes no adjacency, so the INPUT (already run through
 * `transformContextBeforeLLM`, which can splice a synthetic digest / goal-anchor
 * user message between a tool-call turn and its result) may carry a non-adjacent
 * pair that text tolerated but native tool blocks reject. `computePairedToolIds`
 * therefore enforces adjacency explicitly (`isAdjacent`) and degrades any
 * non-adjacent exchange to the text arm. See the adjacency regression tests in
 * content-blocks.test.ts.
 */
export function materializeToolContentBlocks<M extends ToolSidecarMessage>(
  messages: readonly M[],
): Array<M & { contentBlocks?: LlmContentBlock[] }> {
  const pairedToolIds = computePairedToolIds(messages);
  if (pairedToolIds.size === 0) return [...messages];

  return messages.map((message) => {
    const contentBlocks = toolBlocksForMessage(message, pairedToolIds);
    return contentBlocks && contentBlocks.length > 0 ? { ...message, contentBlocks } : message;
  });
}

/**
 * Request-level producer flip for serializers. Tool sidecars need whole-request
 * pairing before blocks are safe; multimodal `contentParts` can still be
 * materialized per message after that pass.
 */
export function withRequestContentBlocks(messages: readonly LlmMessage[]): LlmMessage[] {
  return materializeToolContentBlocks(messages).map(withContentBlocks);
}
