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

/**
 * Hard ceiling on aggregate `imageAttachments` bytes for one send.
 * Library images are stored as base64 data URLs (each individually
 * capped at 2MB by v2a's CONTENT_TOO_LARGE check), and the chat
 * composer caps user-uploaded attachments at ~750KB total — but linked
 * library images bypass both of those budgets because they're injected
 * per turn at send time. Without a cap, three near-2MB linked images
 * would blow past the 5MB worker body limit (MAX_BODY_SIZE_BYTES) and
 * every send would 413. 1.5MB keeps total request bodies comfortably
 * under the worker cap even with the user's own attachments and a
 * full-cap system message.
 */
const MAX_LINKED_LIBRARY_IMAGE_BYTES = 1500 * 1024;

export interface LinkedLibraryContext {
  /** Text block injected into the system message's `library_context`
   *  section. `undefined` when nothing resolved. */
  systemText: string | undefined;
  /** Image items from every resolved library that fit within the
   *  per-turn budget, re-stamped with a fresh id (no `libraryId` /
   *  `label` field — `AttachmentData` doesn't carry those; the model
   *  correlates via `filename` against the [Image: …] reference line
   *  in the system message). Caller routes these into the latest
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
  let usedImageBytes = 0;
  let truncated = false;
  const skippedNames: string[] = [];
  const skippedImageNames: string[] = [];

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
    // `fullyIncluded` is the gate for forwarding this library's
    // images: only when the entire rendered text fits do we ship
    // them. A boundary-truncated library may have its [Image: …]
    // reference lines sliced off, which would orphan the image_url
    // blocks (model gets pixels with no system-message anchor).
    // Dropping images on partial inclusion is the conservative
    // call — the user can raise the cap or trim heavy text libraries.
    let fullyIncluded = false;
    if (rendered.length <= remaining) {
      sections.push(rendered);
      usedBytes += rendered.length;
      fullyIncluded = true;
    } else {
      if (remaining > 0) {
        sections.push(
          `${rendered.slice(0, remaining)}\n\n[Truncated: library "${collection.name}" exceeded the ${MAX_LINKED_LIBRARY_BYTES} byte cap; content above is partial. Image attachments from this library were also dropped to avoid orphan references.]`,
        );
        usedBytes += remaining;
      } else {
        skippedNames.push(collection.name);
      }
      truncated = true;
    }

    if (fullyIncluded) {
      for (const item of fullItems) {
        if (item.type !== 'image') continue;
        const cost = item.content.length;
        // Skip any image that would push past the per-turn image
        // byte budget. We don't pre-aggregate per library because a
        // single 2MB image might still fit when no others have been
        // forwarded; conversely several smaller images stop early.
        if (usedImageBytes + cost > MAX_LINKED_LIBRARY_IMAGE_BYTES) {
          skippedImageNames.push(`${item.filename} (from ${collection.name})`);
          continue;
        }
        imageAttachments.push(toAttachmentData(item, collection));
        usedImageBytes += cost;
      }
    }
  }

  if (sections.length === 0 && skippedNames.length === 0 && skippedImageNames.length === 0) {
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
  if (skippedImageNames.length > 0) {
    parts.push(
      '',
      `[Skipped image attachments (${MAX_LINKED_LIBRARY_IMAGE_BYTES} byte per-turn cap): ${skippedImageNames.join(', ')}. The model cannot see these images this turn.]`,
    );
  }
  return { systemText: parts.join('\n'), imageAttachments };
}

/**
 * v2c — graft linked-library image attachments onto the latest user
 * message in `messages`. Pure function: never mutates `messages` or
 * any of its entries. Returns a new top-level array with the target
 * message cloned (fresh `attachments` array); every other entry
 * keeps reference identity so downstream caches (prompt snapshot,
 * provider memoization) stay warm.
 *
 * No-op (returns the input reference unchanged) when `imageAttachments`
 * is empty or no user message exists, so callers don't pay for a
 * fresh array on the common path.
 */
export function spliceLinkedImagesIntoLastUser(
  messages: ChatMessage[],
  imageAttachments: readonly AttachmentData[],
): ChatMessage[] {
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
  // Re-stamp a fresh id (namespaced under the owning library) so
  // re-injection on every turn doesn't collide with a previously-
  // spliced clone if any consumer holds references. The model
  // correlates the inbound image_url block with its owning library
  // via the `filename` (matching the [Image: filename] line in the
  // system-message library_context section) — AttachmentData has no
  // label or libraryId field, so no extra plumbing exists for richer
  // correlation. The `library` arg is used only for id namespacing.
  return {
    id: `linked-${library.id}-${item.id}-${shortRandomSuffix()}`,
    type: 'image',
    filename: item.filename,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    content: item.content,
    thumbnail: item.thumbnail,
  };
}

/**
 * 8-char random suffix used to disambiguate linked-attachment ids
 * across turns. Prefers `crypto.randomUUID()` for entropy quality but
 * falls back to `Math.random()` in environments where randomUUID
 * isn't available or throws (non-secure contexts, certain embedded
 * runtimes). Collision risk for an 8-char hex slice is irrelevant
 * here — the namespace already includes the library + item ids; this
 * only protects against same-turn re-resolution producing identical
 * ids if a downstream consumer keys on full id equality.
 */
function shortRandomSuffix(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }
}

export const __test = { shortRandomSuffix };

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
