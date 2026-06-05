import { memo, useMemo, useState, useCallback, cloneElement, isValidElement } from 'react';
import {
  ChevronRight,
  FileCode,
  FileText,
  Copy,
  Check,
  Pin,
  Pencil,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import type { ChatMessage, CardAction, AttachmentData, UrlCitation } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';
import { BranchWaveIcon, PushMarkIcon } from '@/components/icons/push-custom-icons';
import { useSmoothStreamedText } from '@/hooks/useSmoothStreamedText';
import {
  looksLikeToolCall,
  ONLY_BRACKETS_RE,
  stripToolCallPayload,
  stripToolResultEnvelopes,
} from './message-content';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  onEdit?: (messageId: string) => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
}

function isToolCallObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.tool === 'string';
}

function isToolCallJson(code: string): boolean {
  try {
    const trimmed = code.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const parsed = JSON.parse(trimmed);
    return isToolCallObject(parsed);
  } catch {
    return false;
  }
}

function formatContent(content: string): React.ReactNode[] {
  if (!content) return [];

  const parts: React.ReactNode[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Fenced code blocks ---
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const fullCode = codeLines.join('\n');
        // Hide raw JSON tool call blocks from chat
        if (!isToolCallJson(fullCode)) {
          parts.push(
            <pre
              key={`code-${codeKey++}`}
              className="my-2 overflow-x-auto rounded-lg border border-push-edge bg-push-surface px-3 py-2.5"
            >
              <code className="font-mono text-push-base text-push-fg-soft leading-relaxed">
                {fullCode}
              </code>
            </pre>,
          );
        }
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // --- Horizontal rule (---, ***, ___) ---
    if (/^(\s*[-*_]\s*){3,}$/.test(line) && line.trim().length >= 3) {
      parts.push(<hr key={`hr-${i}`} className="my-3 border-0 border-t border-push-edge" />);
      continue;
    }

    // --- Headings ---
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const styles: Record<number, string> = {
        1: 'text-[18px] font-semibold text-push-fg mt-4 mb-1.5',
        2: 'text-[16px] font-semibold text-push-fg mt-3 mb-1',
        3: 'text-push-lg font-medium text-push-fg-soft mt-2.5 mb-0.5',
        4: 'text-[14px] font-medium text-push-fg-muted mt-2 mb-0.5 uppercase tracking-wide',
      };
      parts.push(
        <div key={`heading-${i}`} className={styles[level]}>
          {formatInline(headingText)}
        </div>,
      );
      continue;
    }

    // --- Blockquote ---
    if (line.startsWith('> ') || line === '>') {
      const quoteText = line.startsWith('> ') ? line.slice(2) : '';
      parts.push(
        <div
          key={`bq-${i}`}
          className="border-l-2 border-push-edge pl-3 my-1 text-push-fg-muted italic"
        >
          {quoteText ? formatInline(quoteText) : '\u00A0'}
        </div>,
      );
      continue;
    }

    // --- Unordered list item (- or *) ---
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      const indent = Math.min(Math.floor(ulMatch[1].length / 2), 3);
      const itemText = ulMatch[2];
      parts.push(
        <div
          key={`ul-${i}`}
          className="flex items-start gap-2 my-0.5"
          style={{ paddingLeft: `${indent * 16 + 4}px` }}
        >
          <span className="shrink-0 mt-[9px] block w-1 h-1 rounded-full bg-push-fg-dim" />
          <span className="flex-1 min-w-0">{formatInline(itemText)}</span>
        </div>,
      );
      continue;
    }

    // --- Ordered list item (1. 2. etc.) ---
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (olMatch) {
      const indent = Math.min(Math.floor(olMatch[1].length / 2), 3);
      const num = olMatch[2];
      const itemText = olMatch[3];
      parts.push(
        <div
          key={`ol-${i}`}
          className="flex items-start gap-2 my-0.5"
          style={{ paddingLeft: `${indent * 16 + 4}px` }}
        >
          <span className="text-push-fg-dim text-push-base font-mono shrink-0 min-w-[1.25rem] text-right mt-px">
            {num}.
          </span>
          <span className="flex-1 min-w-0">{formatInline(itemText)}</span>
        </div>,
      );
      continue;
    }

    // --- Empty line ---
    if (line.trim() === '') {
      parts.push(<div key={`empty-${i}`} className="h-2" />);
      continue;
    }

    // --- Default: plain text line ---
    parts.push(<div key={`line-${i}`}>{formatInline(line)}</div>);
  }

  // Handle unclosed code blocks (streaming)
  if (inCodeBlock && codeLines.length > 0) {
    const fullCode = codeLines.join('\n');
    if (!isToolCallJson(fullCode)) {
      parts.push(
        <pre
          key={`code-${codeKey}`}
          className="my-2 overflow-x-auto rounded-lg border border-push-edge bg-push-surface px-3 py-2.5"
        >
          <code className="font-mono text-push-base text-push-fg-soft leading-relaxed">
            {fullCode}
          </code>
        </pre>,
      );
    }
  }

  return parts;
}

function formatInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Match bold, italic, inline code, links, and plain text
  // Bold before italic so ** is tried before *
  const regex =
    /(\*\*(.+?)\*\*)|(\*([^*]+?)\*)|(`([^`]+?)`)|(\[([^\]]+)]\(([^)]+)\))|([^*`[]+|[*`[])/g;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // Bold **text**
      result.push(
        <strong key={key++} className="font-semibold text-push-fg">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      // Italic *text*
      result.push(
        <em key={key++} className="italic text-push-fg-soft">
          {match[4]}
        </em>,
      );
    } else if (match[6]) {
      // Inline code `text`
      result.push(
        <code
          key={key++}
          className="rounded border border-push-edge bg-push-surface px-1.5 py-0.5 font-mono text-push-base text-push-fg-soft"
        >
          {match[6]}
        </code>,
      );
    } else if (match[8]) {
      // Link [text](url)
      result.push(
        <a
          key={key++}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-push-accent hover:text-push-link underline underline-offset-2 decoration-push-accent/30 hover:decoration-push-link/50 transition-colors"
        >
          {match[8]}
        </a>,
      );
    } else if (match[10]) {
      // Plain text
      result.push(<span key={key++}>{match[10]}</span>);
    }
  }

  return result;
}

// --- Per-word shimmer reveal (streaming only) ---------------------------------
// Post-process the formatted node tree, splitting plain-text runs into
// individually-keyed word spans so each newly-revealed word can bloom in once
// (CSS `.stream-word`). Keys are assigned in document order from a shared
// counter, so a word keeps its key as the text grows by appending — meaning it
// mounts (and animates) exactly once and stays inert afterward. Code/`pre` are
// skipped: per-word motion inside code reads as noise. Above the char cap we
// bail to the plain tree so a very long answer never pays the per-word cost.
const STREAM_WORD_SKIP_TYPES = new Set(['code', 'pre']);
const MAX_SHIMMER_CHARS = 4000;

function splitTextToWords(text: string, counter: { i: number }): React.ReactNode[] {
  // Keep whitespace runs as bare strings so spacing/wrapping is untouched; wrap
  // only the visible word tokens.
  const out: React.ReactNode[] = [];
  for (const token of text.split(/(\s+)/)) {
    if (token === '') continue;
    if (/^\s+$/.test(token)) {
      out.push(token);
    } else {
      out.push(
        <span key={`sw-${counter.i++}`} className="stream-word">
          {token}
        </span>,
      );
    }
  }
  return out;
}

function wrapStreamWordsNode(node: React.ReactNode, counter: { i: number }): React.ReactNode {
  if (typeof node === 'string') {
    return splitTextToWords(node, counter);
  }
  if (Array.isArray(node)) {
    return node.map((child) => wrapStreamWordsNode(child, counter));
  }
  if (isValidElement(node)) {
    if (typeof node.type === 'string' && STREAM_WORD_SKIP_TYPES.has(node.type)) {
      return node;
    }
    const { children } = node.props as { children?: React.ReactNode };
    if (children == null) return node;
    return cloneElement(node, undefined, wrapStreamWordsNode(children, counter));
  }
  return node;
}

function wrapStreamWords(nodes: React.ReactNode[], textLength: number): React.ReactNode[] {
  if (textLength > MAX_SHIMMER_CHARS) return nodes;
  const counter = { i: 0 };
  return nodes.map((node) => wrapStreamWordsNode(node, counter));
}

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Truncate preview to ~80 chars from the end of thinking
  const preview = thinking.length > 80 ? '\u2026' + thinking.slice(-80).trim() : thinking.trim();

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-push-xs text-push-fg-dim hover:text-push-fg-muted transition-colors duration-150 group"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">{isStreaming ? 'Reasoning' : 'Thought process'}</span>
        {isStreaming && (
          <span className="inline-block w-1 h-1 rounded-full bg-push-fg-dim animate-pulse ml-0.5" />
        )}
      </button>

      {!expanded && !isStreaming && (
        <p className="text-push-sm text-push-fg-dimmest leading-relaxed mt-1 ml-4 line-clamp-2 italic">
          {preview}
        </p>
      )}

      {expanded && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-push-edge max-h-[300px] overflow-y-auto expand-in">
          <p className="text-push-sm text-push-fg-dim leading-relaxed whitespace-pre-wrap break-words">
            {thinking}
          </p>
        </div>
      )}

      {isStreaming && !expanded && thinking && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-push-edge">
          <p className="text-push-sm text-push-fg-dimmest leading-relaxed whitespace-pre-wrap break-words line-clamp-3">
            {thinking.slice(-200)}
          </p>
        </div>
      )}
    </div>
  );
}

/** Parse a citation URL, returning null for anything that isn't a plain
 *  http(s) link. Citation URLs come from upstream web-search results, so a
 *  hostile or malformed entry could carry a `javascript:`/`data:` scheme —
 *  those must never reach an `href`. */
function safeHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function hostnameOf(parsed: URL): string {
  return parsed.hostname.replace(/^www\./, '');
}

/** Web-search sources surfaced by a provider's native search (OpenRouter).
 *  Collapsed by default to one line; expands to the full numbered list. */
function SourcesFooter({ citations }: { citations: UrlCitation[] }) {
  const [expanded, setExpanded] = useState(false);
  // Drop citations whose URL isn't a safe http(s) link — they can't be
  // rendered as a trustworthy source and must not become a clickable href.
  const safe = useMemo(
    () =>
      citations
        .map((c) => ({ c, parsed: safeHttpUrl(c.url) }))
        .filter((x): x is { c: UrlCitation; parsed: URL } => x.parsed !== null),
    [citations],
  );
  if (safe.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-push-xs text-push-fg-dim hover:text-push-fg-muted transition-colors duration-150"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">
          {safe.length} {safe.length === 1 ? 'source' : 'sources'}
        </span>
      </button>

      {expanded && (
        <ol className="mt-1.5 ml-4 space-y-1 list-none">
          {safe.map(({ c, parsed }, i) => {
            const host = hostnameOf(parsed);
            return (
              <li key={`${c.url}-${i}`} className="flex items-baseline gap-1.5 text-push-sm">
                <span className="text-push-fg-dimmest tabular-nums shrink-0">{i + 1}.</span>
                <a
                  href={parsed.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={c.content || c.url}
                  className="group/src inline-flex items-baseline gap-1 min-w-0 text-push-accent hover:text-push-accent-strong transition-colors"
                >
                  <span className="truncate underline decoration-push-accent/30 group-hover/src:decoration-push-accent underline-offset-2">
                    {c.title || host}
                  </span>
                  <span className="text-push-fg-dimmest shrink-0">{host}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 self-center opacity-60" />
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function AttachmentBadge({ attachment }: { attachment: AttachmentData }) {
  const [expanded, setExpanded] = useState(false);

  if (attachment.type === 'image') {
    return (
      <>
        <button
          onClick={() => setExpanded(true)}
          className="block rounded-lg overflow-hidden border border-push-edge hover:border-push-edge-hover transition-colors"
        >
          <img
            src={attachment.thumbnail || attachment.content}
            alt={attachment.filename}
            className="h-16 w-16 object-cover"
          />
        </button>
        {expanded && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setExpanded(false)}
          >
            <img
              src={attachment.content}
              alt={attachment.filename}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>
        )}
      </>
    );
  }

  const Icon = attachment.type === 'code' ? FileCode : FileText;
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-push-surface/50 border border-push-edge px-2 py-1">
      <Icon className="h-3.5 w-3.5 text-push-fg-muted" />
      <span className="text-push-sm text-push-fg-muted truncate max-w-[120px]">
        {attachment.filename}
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-push-fg-soft"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-push-status-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onCardAction,
  onPin,
  onEdit,
  onRegenerate,
  canRegenerate = false,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isStreaming = message.status === 'streaming';
  const hasThinking = Boolean(message.thinking);
  const displayContentText = useMemo(() => {
    if (isUser) {
      return message.displayContent ?? message.content;
    }
    let text = message.content;
    // Always strip leaked tool-result envelopes (safe — only targets our exact format)
    text = stripToolResultEnvelopes(text);
    // Aggressive tool-call JSON stripping for flagged tool calls AND streaming
    // messages (prevents visual flash of raw JSON while model is still outputting).
    // For streaming, gate on a cheap marker check to avoid regex/brace-scan cost
    // on every token update when the response is just plain text.
    // Always apply tool-call stripping to assistant messages if they look like tool calls.
    // This acts as a fail-safe even if the background parser missed a malformed call
    // or the streaming state has finished.
    if (message.isToolCall || message.isMalformed || looksLikeToolCall(text)) {
      text = stripToolCallPayload(text);
    }
    // Tool-call messages: any leftover text after stripping is the model narrating
    // its intent (e.g. "Let me check..." or a delegation task brief). Force-clear
    // so only the tool result / cards are visible — not internal machinery.
    if (message.isToolCall) {
      text = '';
    }
    // Malformed messages are failed tool calls — any leftover text is garbage
    // (e.g. orphaned shell command fragments). Force-clear so the bubble hides.
    if (message.isMalformed) {
      text = '';
    }
    // Strip bracket-only artifacts, but only when we believe the content
    // originated from a tool call / tool JSON, to avoid erasing legitimate
    // minimal JSON-like replies such as "[]" or "{}".
    if ((message.isToolCall || looksLikeToolCall(text)) && ONLY_BRACKETS_RE.test(text)) {
      text = '';
    }
    return text;
  }, [isUser, message.content, message.displayContent, message.isToolCall, message.isMalformed]);
  const hasContent = Boolean(displayContentText.trim());

  // Smooth-stream the assistant's visible text so bursty token arrivals reveal
  // at a steady cadence instead of spilling in jumps. Copy/pin still use the
  // full `displayContentText`; only the rendered body animates. Disabled for
  // user bubbles and once the message has settled (flushes to full instantly).
  const revealedContentText = useSmoothStreamedText(displayContentText, isStreaming && !isUser);

  const visibleCards = useMemo(
    () => (message.cards || []).filter((card) => card.type !== 'sandbox-state'),
    [message.cards],
  );

  const content = useMemo(() => {
    const nodes = formatContent(revealedContentText);
    // While streaming, animate each newly-revealed word in; settled messages
    // render plain markdown so the spans (and their cost) exist only in-flight.
    return isStreaming ? wrapStreamWords(nodes, revealedContentText.length) : nodes;
  }, [revealedContentText, isStreaming]);

  // Hide tool call / malformed messages only when they have no cards.
  // If the model included user-facing text before the JSON call, keep it visible.
  if ((message.isToolCall || message.isMalformed) && !hasContent && visibleCards.length === 0) {
    return null;
  }

  // Slice 2: render `branch_forked` events as a centered transcript divider
  // rather than as an empty assistant bubble. The event has empty `content`
  // (transcript metadata, visibleToModel: false), so without this special
  // case MessageBubble would draw an empty assistant row with avatar +
  // spacing — visible UX bug flagged in PR #412 review (Copilot + Codex).
  if (message.kind === 'branch_forked' && message.branchForkedMeta) {
    const { from, to } = message.branchForkedMeta;
    return (
      <div className="my-3 flex items-center justify-center px-4">
        <div className="flex items-center gap-2 rounded-full border border-push-border bg-push-surface px-3 py-1 text-push-2xs text-push-fg-dim">
          <BranchWaveIcon className="h-3 w-3" />
          <span>
            Forked <span className="font-mono text-push-fg-secondary">{from}</span>
            <span className="mx-1">→</span>
            <span className="font-mono text-push-fg-secondary">{to}</span>
          </span>
        </div>
      </div>
    );
  }

  // Post-merge migration: same transcript-divider treatment as branch_forked,
  // but labels the transition as "Merged" and surfaces the PR number when
  // known. The chat migrated to the default branch instead of being filtered
  // out by the auto-switch effect, so this event marks the seam in history.
  if (message.kind === 'branch_merged' && message.branchMergedMeta) {
    const { from, to, prNumber } = message.branchMergedMeta;
    return (
      <div className="my-3 flex items-center justify-center px-4">
        <div className="flex items-center gap-2 rounded-full border border-push-border bg-push-surface px-3 py-1 text-push-2xs text-push-fg-dim">
          <BranchWaveIcon className="h-3 w-3" />
          <span>
            Merged <span className="font-mono text-push-fg-secondary">{from}</span>
            <span className="mx-1">→</span>
            <span className="font-mono text-push-fg-secondary">{to}</span>
            {prNumber !== undefined ? (
              <span className="ml-1 text-push-fg-dim">(#{prNumber})</span>
            ) : null}
          </span>
        </div>
      </div>
    );
  }

  // Hide tool call / malformed messages only when they have no cards.
  // If the model included user-facing text before the JSON call, keep it visible.
  if ((message.isToolCall || message.isMalformed) && !hasContent && visibleCards.length === 0) {
    return null;
  }

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;

    return (
      <div className="flex justify-end px-4 py-1.5 group/user animate-fade-in-up">
        <div className="opacity-0 group-hover/user:opacity-100 transition-opacity duration-200 flex items-start gap-0.5 pt-2 mr-1.5">
          <CopyButton text={displayContentText} />
          {onEdit && (
            <button
              onClick={() => onEdit(message.id)}
              className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-push-fg-soft"
              title="Edit and resend"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="chat-user-bubble max-w-[85%] rounded-2xl rounded-br-md border px-4 py-3 shadow-push-md">
          {hasAttachments && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.attachments!.map((att) => (
                <AttachmentBadge key={att.id} attachment={att} />
              ))}
            </div>
          )}
          {hasContent && (
            <p className="whitespace-pre-wrap break-words text-push-lg leading-relaxed text-push-fg">
              {displayContentText}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-1.5 group/assistant animate-fade-in">
      <div className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-push-edge bg-push-grad-icon">
        <PushMarkIcon className="h-[10px] w-[10px] text-push-accent" />
      </div>
      <div className="min-w-0 max-w-[85%]">
        {hasThinking && (
          <ThinkingBlock thinking={message.thinking!} isStreaming={isStreaming && !hasContent} />
        )}
        {hasContent && (
          <div
            className={`text-push-lg leading-relaxed break-words ${
              isError ? 'text-red-400' : 'text-push-fg-soft'
            }`}
          >
            {content}
            {isStreaming && <span className="stream-caret bg-push-accent" aria-hidden="true" />}
          </div>
        )}
        {message.citations && message.citations.length > 0 && (
          <SourcesFooter citations={message.citations} />
        )}
        {hasContent && !isStreaming && (
          <div className="opacity-0 group-hover/assistant:opacity-100 transition-opacity duration-200 mt-1.5 flex items-center gap-0.5">
            <CopyButton text={displayContentText} />
            {canRegenerate && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-push-fg-soft"
                title="Regenerate response"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
            {onPin && (
              <button
                onClick={() => onPin(displayContentText, message.id)}
                className="rounded-md p-1.5 text-push-fg-dim transition-colors duration-150 hover:bg-push-surface-active hover:text-push-fg-soft"
                title="Pin to Kept"
              >
                <Pin className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        {visibleCards.length > 0 && (
          <div className="mt-1.5">
            {visibleCards.map((card, i) => (
              <CardRenderer
                key={i}
                card={card}
                messageId={message.id}
                cardIndex={i}
                onAction={onCardAction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
