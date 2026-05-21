/**
 * v2b/v2c — resolve linked libraries into the two payload channels the
 * orchestrator pipeline accepts:
 *
 *   - `systemText`         — rendered into the `library_context` section
 *                            of the system message (v2b path).
 *   - `imageAttachments`   — spliced into the latest user message's
 *                            `attachments[]` by `chat-stream-round.ts` so
 *                            vision-capable models receive the pixels
 *                            via the existing `image_url` block path
 *                            (v2c — system messages are text-only for
 *                            every provider, image_url blocks only flow
 *                            through user messages).
 *
 * Called from `chat-stream-round.ts` at the start of every assistant
 * turn. Both channels are fetched fresh each send — linked-library
 * content is never persisted into chat history. The conversation
 * record only carries `linkedLibraryIds: string[]`.
 *
 * Stale-link tolerance: a missing or unreadable library is silently
 * skipped. The chat metadata keeps the stale id (the user can unlink
 * explicitly), but no exception propagates.
 */

import { collectionsGet } from './chat-library-client';
import type { AttachmentData, ChatMessage } from '@/types';
import type { Library, LibraryItem } from './chat-library-types';

const HEADER = '# Linked libraries';
const INTRO =
  'The following user-managed libraries are linked to this chat. Their full contents are below; reference them as canonical context for the user, the same way you would treat an attached file. Do not invent material outside what is provided.';

/**
 * Hard ceiling on total rendered systemText bytes across every linked
 * library. Image bytes are not counted toward this cap — they travel
 * via the user-message attachments path and are already bounded by
 * the per-item 2MB server cap from v2a. ~400KB sits well within every
 * common provider's context window (Anthropic 200K tokens ≈ 800KB,
 * GPT-4 turbo 128K ≈ 500KB) and leaves headroom for the rest of the
 * system prompt + conversation. When the cap is hit, earlier
 * libraries render fully, the boundary library is hard-truncated, and
 * any remaining libraries are listed by name only with a tail marker
 * so the model sees explicit gaps.
 */
const MAX_LINKED_LIBRARY_BYTES = 400 * 1024;

export interface LinkedLibraryContext {
  /** Text block injected into the system message's `library_context`
   *  section. `undefined` when nothing resolved. */
  systemText: string | undefined;
  /** Image items from every resolved library, with `libraryId` /
   *  `label` / etc. preserved. Caller routes these into the latest
   *  user message's `attachments[]` so the existing orchestrator
   *  image_url-block conversion picks them up. Always an array
   *  (possibly empty). */
  imageAttachments: AttachmentData[];
}

/**
 * Fetch every library in `libraryIds` and split the result into the
 * two payload channels. Returns empty payload when no libraries
 * resolved (empty input, all stale, all failed).
 */
export async function buildLinkedLibraryContext(
  libraryIds: readonly string[],
): Promise<LinkedLibraryContext> {
  if (libraryIds.length === 0) {
    return { systemText: undefined, imageAttachments: [] };
  }

  // Parallel fetch — each collections/get is an independent round-trip.
  // Skip any that fail (NOT_FOUND, network error, etc.) — the helper
  // is best-effort and never throws.
  const results = await Promise.all(
    libraryIds.map((id) => collectionsGet(id, { includeContent: true }).catch(() => null)),
  );

  const sections: string[] = [];
  const imageAttachments: AttachmentData[] = [];
  let usedBytes = 0;
  let truncated = false;
  const skippedNames: string[] = [];

  for (const res of results) {
    if (!res || !res.ok) continue;
    const { collection, items } = res.data;
    const fullItems = (items as LibraryItem[]).filter(
      (item): item is LibraryItem => typeof item.content === 'string',
    );
    if (truncated) {
      skippedNames.push(collection.name);
      continue;
    }
    const rendered = renderLibrary(collection, fullItems);
    const remaining = MAX_LINKED_LIBRARY_BYTES - usedBytes;
    let includedThisLibrary = true;
    if (rendered.length <= remaining) {
      sections.push(rendered);
      usedBytes += rendered.length;
    } else {
      if (remaining > 0) {
        sections.push(
          `${rendered.slice(0, remaining)}\n\n[Truncated: library "${collection.name}" exceeded the ${MAX_LINKED_LIBRARY_BYTES} byte cap; content above is partial.]`,
        );
        usedBytes += remaining;
      } else {
        skippedNames.push(collection.name);
        includedThisLibrary = false;
      }
      truncated = true;
    }
    // Image items from this library are forwarded only when the
    // library's text content was at least partially included.
    // Otherwise the model has no system-message reference to pair
    // with the image, and surfacing orphan pixels is worse than
    // dropping them with the explicit "skipped" tail message.
    if (includedThisLibrary) {
      for (const item of fullItems) {
        if (item.type !== 'image') continue;
        imageAttachments.push(toAttachmentData(item, collection));
      }
    }
  }

  if (sections.length === 0 && skippedNames.length === 0) {
    return { systemText: undefined, imageAttachments };
  }
  const parts = [HEADER, '', INTRO, ''];
  if (sections.length > 0) parts.push(sections.join('\n\n'));
  if (skippedNames.length > 0) {
    parts.push(
      '',
      `[Skipped due to ${MAX_LINKED_LIBRARY_BYTES} byte cap: ${skippedNames.join(', ')}. Unlink one of the earlier libraries to include these.]`,
    );
  }
  return { systemText: parts.join('\n'), imageAttachments };
}

/**
 * v2c — graft linked-library image attachments onto the latest user
 * message in `messages`. Pure function: returns a new array with the
 * target message cloned (fresh `attachments` array) and everything
 * else passed by reference identity so downstream caches stay warm.
 *
 * No-op (returns `messages` unchanged) when `imageAttachments` is
 * empty or no user message exists. The clone is intentionally
 * shallow — `apiMessages` is owned by the caller and other downstream
 * code only reads the user message's content, never mutates its
 * attachments after this point.
 */
export function spliceLinkedImagesIntoLastUser(
  messages: readonly ChatMessage[],
  imageAttachments: readonly AttachmentData[],
): readonly ChatMessage[] {
  if (imageAttachments.length === 0) return messages;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  const target = messages[lastUserIdx];
  const cloned: ChatMessage = {
    ...target,
    attachments: [...(target.attachments ?? []), ...imageAttachments],
  };
  return [...messages.slice(0, lastUserIdx), cloned, ...messages.slice(lastUserIdx + 1)];
}

function toAttachmentData(item: LibraryItem, library: Library): AttachmentData {
  // Re-stamp a fresh id so re-injection on every turn doesn't collide
  // with a previously-spliced clone if any consumer holds references.
  // Label is enriched with the library name so the model can correlate
  // the image with its system-message library reference. Filename
  // stays as-stored.
  return {
    id: `linked-${library.id}-${item.id}-${crypto.randomUUID().slice(0, 8)}`,
    type: 'image',
    filename: item.filename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    content: item.content,
    thumbnail: item.thumbnail,
  };
}

function renderLibrary(library: Library, items: readonly LibraryItem[]): string {
  const parts: string[] = [`## Library: ${library.name}`];
  if (typeof library.instructions === 'string' && library.instructions.length > 0) {
    parts.push('', '[Instructions]', library.instructions);
  }
  if (items.length > 0) {
    parts.push('', '[Files]');
    for (const item of items) {
      parts.push('', `File: ${item.label ? `${item.label} (${item.filename})` : item.filename}`);
      if (item.type === 'image') {
        // v2c — image bytes are routed via the caller's user-message
        // attachments path so vision-capable models can see the
        // pixels. The system message still surfaces a metadata line
        // so the model can correlate "image X is part of library Y"
        // when it sees the image_url block alongside this text.
        parts.push(
          `[Image: ${item.filename} (${item.mimeType}, ${item.sizeBytes} bytes) — pixels delivered via user-message attachment]`,
        );
      } else {
        // Dynamic fence so markdown content with inner ``` doesn't
        // close our outer fence and bleed the rest of the system
        // prompt into a code block.
        const fence = chooseFence(item.content);
        parts.push(fence, item.content, fence);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Find the longest run of backticks in `content`, return a fence one
 * longer. Minimum length 3 (the markdown default).
 */
function chooseFence(content: string): string {
  let longest = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === '`') {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}
