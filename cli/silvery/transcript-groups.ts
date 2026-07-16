import { formatToolGroupSummary } from '../../lib/tool-display.js';
import type { SilveryTranscriptItem } from './controller.js';

export interface SilveryTranscriptToolGroup {
  id: string;
  items: readonly SilveryTranscriptItem[];
  kind: 'tool_group';
  summary: string;
}

export type SilveryTranscriptDisplayItem = SilveryTranscriptItem | SilveryTranscriptToolGroup;

function isGroupableTool(item: SilveryTranscriptItem): boolean {
  return item.kind === 'tool' && !item.pending && !item.isError;
}

/**
 * Presentation-only grouping for Silvery. The controller's transcript rows
 * remain lossless and independently addressable; this projection only folds
 * runs of two or more consecutive, settled, successful tool calls.
 */
export function groupSilveryTranscriptRows(
  rows: readonly SilveryTranscriptItem[],
): SilveryTranscriptDisplayItem[] {
  const display: SilveryTranscriptDisplayItem[] = [];
  let index = 0;

  while (index < rows.length) {
    const first = rows[index];
    if (!first || !isGroupableTool(first)) {
      if (first) display.push(first);
      index += 1;
      continue;
    }

    const items: SilveryTranscriptItem[] = [first];
    let next = index + 1;
    while (next < rows.length) {
      const candidate = rows[next];
      if (!candidate || !isGroupableTool(candidate)) break;
      items.push(candidate);
      next += 1;
    }

    if (items.length === 1) {
      display.push(first);
    } else {
      display.push({
        id: `tool-group-${first.id}`,
        kind: 'tool_group',
        items,
        summary: formatToolGroupSummary(
          items.map((item) => ({
            toolName: item.toolName ?? item.text,
            target: item.target,
          })),
        ),
      });
    }
    index = next;
  }

  return display;
}
