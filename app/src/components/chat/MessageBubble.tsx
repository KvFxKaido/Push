import { memo, useMemo, useState } from 'react';
import { ChevronRight, GitPullRequest, GitBranch, GitCommit, FileCode, Terminal, FileDiff, PenTool, ShieldCheck, Activity, FolderOpen } from 'lucide-react';
import type { ChatMessage, CardAction } from '@/types';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { CardRenderer } from '@/components/cards/CardRenderer';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
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

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        parts.push(
          <pre
            key={`code-${codeKey++}`}
            className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1e] px-3 py-2.5 overflow-x-auto"
          >
            <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
              {codeLines.join('\n')}
            </code>
          </pre>,
        );
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

    // Render regular line with inline formatting
    parts.push(
      <span key={`line-${i}`}>
        {i > 0 && !inCodeBlock && <br />}
        {formatInline(line)}
      </span>,
    );
  }

  // Handle unclosed code blocks
  if (inCodeBlock && codeLines.length > 0) {
    parts.push(
      <pre
        key={`code-${codeKey}`}
        className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1e] px-3 py-2.5 overflow-x-auto"
      >
        <code className="font-mono text-[13px] text-[#e4e4e7] leading-relaxed">
          {codeLines.join('\n')}
        </code>
      </pre>,
    );
  }

  return parts;
}

function formatInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Match bold (**text**), inline code (`text`), and plain text
  const regex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|([^*`]+)/g;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // Bold
      result.push(
        <strong key={key++} className="font-semibold text-[#fafafa]">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      // Inline code
      result.push(
        <code
          key={key++}
          className="font-mono text-[13px] bg-[#111113] border border-[#1a1a1e] rounded px-1.5 py-0.5 text-[#e4e4e7]"
        >
          {match[4]}
        </code>,
      );
    } else if (match[5]) {
      result.push(<span key={key++}>{match[5]}</span>);
    }
  }

  return result;
}

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Truncate preview to ~80 chars from the end of thinking
  const preview = thinking.length > 80 ? '…' + thinking.slice(-80).trim() : thinking.trim();

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-[11px] text-[#52525b] hover:text-[#888] transition-colors duration-150 group"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium">
          {isStreaming ? 'Reasoning' : 'Thought process'}
        </span>
        {isStreaming && (
          <span className="inline-block w-1 h-1 rounded-full bg-[#52525b] animate-pulse ml-0.5" />
        )}
      </button>

      {!expanded && !isStreaming && (
        <p className="text-[12px] text-[#3a3a3e] leading-relaxed mt-1 ml-4 line-clamp-2 italic">
          {preview}
        </p>
      )}

      {expanded && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-[#1a1a1e] max-h-[300px] overflow-y-auto">
          <p className="text-[12px] text-[#52525b] leading-relaxed whitespace-pre-wrap break-words">
            {thinking}
          </p>
        </div>
      )}

      {isStreaming && !expanded && thinking && (
        <div className="mt-1.5 ml-4 pl-3 border-l border-[#1a1a1e]">
          <p className="text-[12px] text-[#3a3a3e] leading-relaxed whitespace-pre-wrap break-words line-clamp-3">
            {thinking.slice(-200)}
          </p>
        </div>
      )}
    </div>
  );
}

function ToolCallStatus({ content }: { content: string }) {
  const toolCall = detectAnyToolCall(content);
  if (!toolCall) return null;

  let Icon = GitBranch;
  let label = '';

  if (toolCall.source === 'github') {
    switch (toolCall.call.tool) {
      case 'fetch_pr':
        Icon = GitPullRequest;
        label = `Fetching PR #${toolCall.call.args.pr} from ${toolCall.call.args.repo}`;
        break;
      case 'list_prs':
        Icon = GitPullRequest;
        label = `Listing ${toolCall.call.args.state || 'open'} PRs on ${toolCall.call.args.repo}`;
        break;
      case 'list_commits':
        Icon = GitCommit;
        label = `Fetching recent commits on ${toolCall.call.args.repo}`;
        break;
      case 'read_file':
        Icon = FileCode;
        label = `Reading ${toolCall.call.args.path} from ${toolCall.call.args.repo}`;
        break;
      case 'list_directory':
        Icon = FolderOpen;
        label = `Browsing ${toolCall.call.args.path || '/'} on ${toolCall.call.args.repo}`;
        break;
      case 'list_branches':
        Icon = GitBranch;
        label = `Listing branches on ${toolCall.call.args.repo}`;
        break;
      case 'fetch_checks':
        Icon = Activity;
        label = `Fetching CI status for ${toolCall.call.args.repo}`;
        break;
    }
  } else if (toolCall.source === 'sandbox') {
    switch (toolCall.call.tool) {
      case 'sandbox_exec':
        Icon = Terminal;
        label = `Running: ${toolCall.call.args.command.slice(0, 60)}${toolCall.call.args.command.length > 60 ? '…' : ''}`;
        break;
      case 'sandbox_read_file':
        Icon = FileCode;
        label = `Reading ${toolCall.call.args.path}`;
        break;
      case 'sandbox_write_file':
        Icon = PenTool;
        label = `Writing ${toolCall.call.args.path}`;
        break;
      case 'sandbox_list_dir':
        Icon = FolderOpen;
        label = `Browsing ${toolCall.call.args.path || '/workspace'}`;
        break;
      case 'sandbox_diff':
        Icon = FileDiff;
        label = 'Getting diff';
        break;
      case 'sandbox_prepare_commit':
        Icon = ShieldCheck;
        label = `Reviewing commit: ${toolCall.call.args.message.slice(0, 50)}`;
        break;
    }
  } else if (toolCall.source === 'delegate') {
    Icon = Terminal;
    label = `Delegating to Coder: ${toolCall.call.args.task.slice(0, 50)}${toolCall.call.args.task.length > 50 ? '…' : ''}`;
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <div className="flex items-center gap-1.5 rounded-full bg-[#111113] border border-[#1a1a1e] px-3 py-1">
        <Icon className="h-3 w-3 text-[#0070f3]" />
        <span className="text-[12px] text-[#52525b] font-medium">{label}</span>
      </div>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onCardAction,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isError = message.status === 'error';
  const isStreaming = message.status === 'streaming';
  const hasThinking = Boolean(message.thinking);
  const hasContent = Boolean(message.content);

  const content = useMemo(
    () => formatContent(message.content),
    [message.content],
  );

  // Hide tool result messages entirely (synthetic data injected for the API)
  if (message.isToolResult) {
    return null;
  }

  // Tool call messages: show a compact status line instead of raw JSON
  if (message.isToolCall) {
    return <ToolCallStatus content={message.content} />;
  }

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1a1a2e] px-4 py-2.5">
          <p className="text-[15px] leading-relaxed text-[#fafafa] whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 px-4 py-1">
      <div className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#111113] border border-[#1a1a1e]">
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          className="text-[#0070f3]"
        >
          <path
            d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="min-w-0 max-w-[85%]">
        {hasThinking && (
          <ThinkingBlock
            thinking={message.thinking!}
            isStreaming={isStreaming && !hasContent}
          />
        )}
        <div
          className={`text-[15px] leading-relaxed break-words ${
            isError ? 'text-red-400' : 'text-[#d4d4d8]'
          }`}
        >
          {content}
          {isStreaming && (
            <span className="inline-block w-[6px] h-[16px] bg-[#0070f3] ml-0.5 align-text-bottom animate-blink" />
          )}
        </div>
        {message.cards && message.cards.length > 0 && (
          <div className="mt-1">
            {message.cards.map((card, i) => (
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
