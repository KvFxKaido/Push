import type { AttachmentData } from '@/types';
import type { LlmContentPart } from '@push/lib/provider-contract';

export function buildAttachmentContentParts(
  text: string,
  attachments: AttachmentData[] | undefined,
): LlmContentPart[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  const contentParts: LlmContentPart[] = [];
  if (text) {
    contentParts.push({ type: 'text', text });
  }

  for (const att of attachments) {
    if (att.type === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: { url: att.content },
      });
    } else {
      contentParts.push({
        type: 'text',
        text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
      });
    }
  }

  return contentParts;
}

/** Convert a flat list of prior-turn attachments into content parts for
 *  injection into the kernel's initial user message alongside the text preamble.
 *  Images become an attribution label + image_url part (so multiple prior
 *  screenshots aren't ambiguous to the model); other files become a labeled
 *  text block. Returns an empty array when there are no prior attachments. */
export function buildPriorTurnAttachmentParts(attachments: AttachmentData[]): LlmContentPart[] {
  const parts: LlmContentPart[] = [];
  for (const att of attachments) {
    if (att.type === 'image') {
      parts.push({ type: 'text', text: `[Image from prior turn: ${att.filename}]` });
      parts.push({ type: 'image_url', image_url: { url: att.content } });
    } else {
      parts.push({
        type: 'text',
        text: `[Attached file from prior turn: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
      });
    }
  }
  return parts;
}

/** Assemble the kernel's initial user message content parts: the task
 *  preamble text first, then prior-turn attachment parts, then current-turn
 *  attachment parts. Returns `undefined` when there is no multimodal content
 *  at all (the kernel falls back to the plain `taskPreamble` string).
 *
 *  Centralizes the merge so the inline lane (`chat-send-inline.ts`) and the
 *  background DO lane (`coder-job-do.ts`) stay symmetric, and so the text
 *  part is emitted explicitly rather than relying on `buildAttachmentContentParts`
 *  happening to place it at index 0. */
export function mergeInitialUserContentParts(
  taskPreamble: string,
  priorAttParts: LlmContentPart[],
  currentAttachments: AttachmentData[] | undefined,
): LlmContentPart[] | undefined {
  // Pass an empty text so we get only the attachment parts back; the text
  // preamble is emitted once, explicitly, below.
  const currentAttParts = buildAttachmentContentParts('', currentAttachments) ?? [];
  if (priorAttParts.length === 0 && currentAttParts.length === 0) {
    return undefined;
  }
  return [{ type: 'text', text: taskPreamble }, ...priorAttParts, ...currentAttParts];
}
