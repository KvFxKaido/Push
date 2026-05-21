/**
 * v2b — fetch + render the system-message text block for libraries
 * linked to a chat.
 *
 * Called from `chat-stream-round.ts` at the start of every assistant
 * turn. The output is passed verbatim into `toLLMMessages` as the
 * `linkedLibraryContent` parameter, which `orchestrator.ts` injects
 * under the `library_context` section of the system prompt.
 *
 * Fresh-fetch semantics: linked-library *content* is never persisted
 * into chat history. The conversation record only carries
 * `linkedLibraryIds: string[]`, and this helper resolves them anew
 * each turn. That keeps IndexedDB lean and lets library edits take
 * effect immediately on the next send.
 *
 * Stale-link tolerance: a missing or unreadable library is silently
 * skipped — it doesn't fail the send. The chat metadata keeps the
 * stale id (the user can unlink explicitly), but no exception
 * propagates.
 */

import { collectionsGet } from './chat-library-client';
import type { Library, LibraryItem } from './chat-library-types';

const HEADER = '# Linked libraries';
const INTRO =
  'The following user-managed libraries are linked to this chat. Their full contents are below; reference them as canonical context for the user, the same way you would treat an attached file. Do not invent material outside what is provided.';

/**
 * Fetch + render every library in `libraryIds` into a single block.
 * Returns `undefined` when no libraries resolved (empty input, all
 * stale, or all failed) so the caller can short-circuit the
 * orchestrator's `library_context` set.
 */
export async function buildLinkedLibraryContext(
  libraryIds: readonly string[],
): Promise<string | undefined> {
  if (libraryIds.length === 0) return undefined;

  // Parallel fetch — each collections/get is an independent round-trip.
  // Skip any that fail (NOT_FOUND, network error, etc.) — the helper
  // is best-effort and never throws.
  const results = await Promise.all(
    libraryIds.map((id) => collectionsGet(id, { includeContent: true }).catch(() => null)),
  );

  const sections: string[] = [];
  for (const res of results) {
    if (!res || !res.ok) continue;
    const { collection, items } = res.data;
    // Items returned with includeContent=true carry their `content`
    // field; filter defensively in case the server shape ever drifts.
    const fullItems = (items as LibraryItem[]).filter(
      (item): item is LibraryItem => typeof item.content === 'string',
    );
    sections.push(renderLibrary(collection, fullItems));
  }

  if (sections.length === 0) return undefined;
  return [HEADER, '', INTRO, '', sections.join('\n\n')].join('\n');
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
      // Wrap text in a code fence so the model treats it as a literal
      // attachment. Images are rare in v2a libraries (mostly canon
      // markdown) but if one shows up we render the data URL inline —
      // the chat-attachment pipeline normally pulls images out before
      // they reach the system prompt; here the URL is best-effort.
      if (item.type === 'image') {
        parts.push(`[image: ${item.mimeType}, ${item.sizeBytes} bytes]`);
      } else {
        parts.push('```', item.content, '```');
      }
    }
  }
  return parts.join('\n');
}
