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
 *  Images become image_url parts; other files become text parts. Returns an
 *  empty array when there are no prior attachments. */
export function buildPriorTurnAttachmentParts(attachments: AttachmentData[]): LlmContentPart[] {
  const parts: LlmContentPart[] = [];
  for (const att of attachments) {
    if (att.type === 'image') {
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
