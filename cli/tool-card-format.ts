import { isToolCard, type ToolCardPayload } from '../lib/tool-cards.js';

export interface ToolCardDisplay {
  title: string;
  rows: Array<{ label: string; value: string }>;
  known: boolean;
}

const VALUE_LIMIT = 180;
const ROW_LIMIT = 8;

function humanize(value: string): string {
  const label = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return label.replace(/\b(?:Api|Ci|Cli|Id|Pr|Sha|Tui|Url)\b/g, (token) => token.toUpperCase());
}

function truncate(value: string, limit = VALUE_LIMIT): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      return truncate(value.join(', '));
    }
    return `${value.length} item${value.length === 1 ? '' : 's'}`;
  }
  if (typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? truncate(serialized) : '[structured data]';
    } catch {
      return '[structured data]';
    }
  }
  return truncate(String(value));
}

/**
 * Turn a declared card into the bounded generic fallback shared by CLI
 * renderers. Known cards get title + key/value rows; unknown future card types
 * become an inert tombstone so persisted chats remain renderable.
 */
export function formatToolCard(card: ToolCardPayload): ToolCardDisplay {
  if (!isToolCard(card)) {
    return {
      title: `Unsupported tool card · ${card.type}`,
      rows: [],
      known: false,
    };
  }

  const entries = Object.entries(card.data).filter(([, value]) => value !== undefined);
  const rows = entries.slice(0, ROW_LIMIT).map(([key, value]) => ({
    label: humanize(key),
    value: formatValue(value),
  }));
  if (entries.length > ROW_LIMIT) {
    rows.push({ label: 'More', value: `${entries.length - ROW_LIMIT} fields` });
  }
  return {
    title: humanize(card.type),
    rows,
    known: true,
  };
}
