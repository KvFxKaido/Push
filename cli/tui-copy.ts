/**
 * tui-copy.ts — Pure helpers for the /copy command: extract semantic chunks
 * from the TUI transcript so they can be pushed to the clipboard via OSC 52.
 *
 * Kept dependency-free so it can be unit-tested without bootstrapping the TUI.
 */

interface TranscriptEntry {
  role: string;
  text?: string;
}

interface TuiStateLike {
  transcript: TranscriptEntry[];
}

/** Format a byte count as a short human string (e.g. "1.2 KB"). */
export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Return the text of the most recent assistant entry with non-empty content. */
export function findLastAssistantText(tuiState: TuiStateLike): string | null {
  for (let i = tuiState.transcript.length - 1; i >= 0; i--) {
    const e = tuiState.transcript[i];
    if (e.role === 'assistant' && typeof e.text === 'string' && e.text.length > 0) {
      return e.text;
    }
  }
  return null;
}

/**
 * Find the last fenced code block (```lang\n...\n```) in assistant transcript
 * entries, scanning newest-first. Returns the block's inner content with a
 * trailing newline stripped, or null if none found. Only ``` fences are
 * recognized — ~~~ fences are uncommon in assistant output.
 */
export function findLastCodeBlock(tuiState: TuiStateLike): string | null {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  for (let i = tuiState.transcript.length - 1; i >= 0; i--) {
    const e = tuiState.transcript[i];
    if (e.role !== 'assistant' || typeof e.text !== 'string') continue;
    let last: string | null = null;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(e.text)) !== null) last = m[1];
    if (last !== null) return last.replace(/\n$/, '');
  }
  return null;
}
