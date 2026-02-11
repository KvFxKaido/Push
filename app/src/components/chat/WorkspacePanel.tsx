/**
 * WorkspacePanel — tabbed side panel combining Console + Scratchpad.
 *
 * Slides from the right on all screen sizes.
 * Mobile: nearly full-width overlay.
 * Desktop: fixed 420px side panel.
 *
 * Console tab: read-only log of tool calls and results.
 * Scratchpad tab: shared notepad editable by user and agent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkPlus, Check, StickyNote, TerminalSquare, Trash2, X } from 'lucide-react';
import type { ChatMessage } from '@/types';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { detectAnyToolCall } from '@/lib/tool-dispatch';

type ToolCallLike = { tool?: string; args?: unknown; task?: unknown };

interface WorkspacePanelProps {
  isOpen: boolean;
  onClose: () => void;
  // Console
  messages: ChatMessage[];
  // Scratchpad
  content: string;
  memories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onContentChange: (content: string) => void;
  onClear: () => void;
  onSaveMemory: (name: string) => void;
  onLoadMemory: (id: string | null) => void;
  onDeleteMemory: (id: string) => void;
}

type Tab = 'console' | 'scratchpad';

export function WorkspacePanel({
  isOpen,
  onClose,
  messages,
  content,
  memories,
  activeMemoryId,
  onContentChange,
  onClear,
  onSaveMemory,
  onLoadMemory,
  onDeleteMemory,
}: WorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('console');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [isNamingMemory, setIsNamingMemory] = useState(false);
  const [memoryName, setMemoryName] = useState('');

  // ── Console log extraction ──────────────────────────────────────────
  const logs = useMemo(() => {
    const items: { type: 'call' | 'result'; tool?: string; content: string; timestamp: number }[] = [];
    messages.forEach((m) => {
      if (m.role === 'assistant') {
        const toolCall = detectAnyToolCall(m.content);
        if (toolCall) {
          const callObj = toolCall.call as ToolCallLike;
          const argsText = JSON.stringify(callObj.args || callObj.task || '');
          items.push({
            type: 'call',
            tool: callObj.tool,
            content: `> ${callObj.tool}: ${argsText.slice(0, 500)}${argsText.length > 500 ? '...' : ''}`,
            timestamp: m.timestamp,
          });
        }
      } else if (m.isToolResult) {
        items.push({ type: 'result', content: m.content, timestamp: m.timestamp });
      }
    });
    return items;
  }, [messages]);

  // ── Keyboard & focus ────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus textarea when scratchpad tab becomes active
  useEffect(() => {
    if (isOpen && activeTab === 'scratchpad' && textareaRef.current) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, activeTab]);

  // Focus name input when entering naming mode
  useEffect(() => {
    if (isNamingMemory && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isNamingMemory]);

  // Track mobile virtual keyboard inset so the side panel stays usable while typing.
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateInset = () => {
      const rawInset = window.innerHeight - viewport.height - viewport.offsetTop;
      const nextInset = Math.max(0, Math.round(rawInset));
      setKeyboardInset(nextInset > 1 ? nextInset : 0);
    };

    updateInset();
    viewport.addEventListener('resize', updateInset);
    viewport.addEventListener('scroll', updateInset);
    return () => {
      viewport.removeEventListener('resize', updateInset);
      viewport.removeEventListener('scroll', updateInset);
    };
  }, [isOpen]);

  // ── Scratchpad memory handlers ──────────────────────────────────────
  const handleStartNaming = () => {
    setMemoryName('');
    setIsNamingMemory(true);
  };

  const handleCancelNaming = () => {
    setIsNamingMemory(false);
    setMemoryName('');
  };

  const handleConfirmNaming = () => {
    const trimmed = memoryName.trim();
    if (!trimmed) return;
    onSaveMemory(trimmed);
    setIsNamingMemory(false);
    setMemoryName('');
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmNaming();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelNaming();
    }
  };

  const handleLoadMemory = (value: string) => {
    onLoadMemory(value || null);
  };

  const activeMemory = memories.find((memory) => memory.id === activeMemoryId) ?? null;
  const panelStyle = isOpen && keyboardInset > 0
    ? { paddingBottom: `calc(env(safe-area-inset-bottom) + ${keyboardInset}px)` }
    : undefined;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop (mobile only) */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 md:hidden ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        style={panelStyle}
        className={`fixed z-50 bg-[linear-gradient(180deg,#05070b_0%,#020306_100%)] border-[#151b26] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] flex flex-col
          inset-y-0 right-0 w-[90vw] max-w-[420px] rounded-l-2xl border-l shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] pb-[env(safe-area-inset-bottom)] md:pb-0
          ${isOpen ? 'translate-x-0' : 'translate-x-full'}
        `}
      >
        {/* Header: close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-push-edge shrink-0">
          {/* Scratchpad actions (only visible on scratchpad tab) */}
          <div className={`flex items-center gap-1 ${activeTab === 'scratchpad' ? '' : 'invisible'}`}>
            <button
              onClick={handleStartNaming}
              disabled={!content.trim() || isNamingMemory}
              className="flex h-10 items-center gap-1 rounded-lg px-2 text-xs font-medium text-push-fg-dim transition-colors hover:text-push-fg-secondary hover:bg-[#080b10]/95 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Save scratchpad memory"
              title="Save memory"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              Save
            </button>
            <button
              onClick={onClear}
              disabled={!content.trim()}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:text-push-fg-secondary hover:bg-[#080b10]/95 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Clear scratchpad"
              title="Clear"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:text-push-fg-secondary hover:bg-[#080b10]/95 active:scale-95"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-4 py-2 border-b border-push-edge shrink-0">
          {([
            ['console', 'Console', TerminalSquare],
            ['scratchpad', 'Scratchpad', StickyNote],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === key
                  ? 'bg-[#101621] text-push-fg'
                  : 'text-push-fg-dim hover:text-[#d1d8e6]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* ── Console tab content ── */}
        <div className={`flex-1 flex flex-col overflow-hidden ${activeTab === 'console' ? '' : 'hidden'}`}>
          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-push-fg-secondary">
            <div className="space-y-3">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={
                    log.type === 'call'
                      ? 'text-[#d1d8e6]'
                      : 'text-[#6f7787] border-l border-push-edge ml-1 pl-3'
                  }
                >
                  {log.content}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Scratchpad tab content ── */}
        <div className={`flex-1 flex flex-col overflow-hidden ${activeTab === 'scratchpad' ? '' : 'hidden'}`}>
          {/* Inline memory naming input */}
          {isNamingMemory && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-push-edge bg-[#05070b] shrink-0">
              <input
                ref={nameInputRef}
                type="text"
                value={memoryName}
                onChange={(e) => setMemoryName(e.target.value)}
                onKeyDown={handleNameKeyDown}
                placeholder="Name this memory..."
                className="h-10 flex-1 rounded-lg border border-push-edge bg-push-surface px-3 text-xs text-[#e2e8f0] outline-none focus:border-push-sky/50 placeholder:text-[#6f7787]"
                aria-label="Memory name"
              />
              <button
                onClick={handleConfirmNaming}
                disabled={!memoryName.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500 text-white transition-colors hover:bg-emerald-600 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
                aria-label="Confirm memory name"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={handleCancelNaming}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-push-fg-dim transition-colors hover:text-push-fg-secondary hover:bg-[#080b10]/95 active:scale-95"
                aria-label="Cancel naming"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Memory selector */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-push-edge shrink-0">
            <select
              value={activeMemoryId ?? ''}
              onChange={(e) => handleLoadMemory(e.target.value)}
              className="h-10 flex-1 rounded-lg border border-push-edge bg-push-surface px-2 text-xs text-[#e2e8f0] outline-none focus:border-push-sky/50"
              aria-label="Select saved memory"
            >
              <option value="">Scratchpad (unsaved)</option>
              {memories.map((memory) => (
                <option key={memory.id} value={memory.id}>
                  {memory.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => activeMemory && onDeleteMemory(activeMemory.id)}
              disabled={!activeMemory}
              className="flex h-10 items-center rounded-lg border border-push-edge px-2 text-xs text-push-fg-dim transition-colors hover:text-[#f97316] hover:border-push-edge-hover hover:bg-[#080b10]/95 active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Delete memory"
            >
              Delete
            </button>
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-hidden p-3">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              placeholder={`Shared notes between you and the agent...\n\n• Paste code, errors, requirements\n• Ask the agent to add ideas here\n• Reference in conversation\n\nThe agent sees this in every message.`}
              className="h-full w-full resize-none bg-push-surface border border-push-edge rounded-xl px-4 py-3 text-sm text-push-fg placeholder:text-[#6f7787] outline-none focus:border-push-sky/50 font-mono leading-relaxed"
            />
          </div>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-push-edge shrink-0">
            <p className="text-xs text-push-fg-dim">
              The agent can update this via <code className="text-push-fg-muted">set_scratchpad</code> or{' '}
              <code className="text-push-fg-muted">append_scratchpad</code>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
