/**
 * Producer flip for the Anthropic-conceptual contract migration (see
 * `docs/decisions/Provider Contract — Anthropic-Conceptual Neutral Hub.md`).
 *
 * Derives the canonical `LlmContentBlock[]` representation from a message's
 * legacy `content` / `contentParts` / `reasoningBlocks` fields, so the
 * serializers run their block path in production rather than the legacy
 * branches. The mapping is lossless for everything the legacy serializer paths
 * read, so the wire output is equivalent — this turns the migration on, it does
 * not change behavior.
 */

import type {
  LlmContentBlock,
  LlmContentPart,
  LlmImageSource,
  LlmMessage,
} from './provider-contract.ts';

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

function contentPartToBlock(part: LlmContentPart): LlmContentBlock | null {
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
  return null;
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
      const block = contentPartToBlock(part);
      if (block) blocks.push(block);
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
