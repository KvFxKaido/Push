import { useState, useCallback } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Pin, Trash2 } from 'lucide-react';
import type { PinnedArtifact } from '@/hooks/usePinnedArtifacts';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface HubKeptTabProps {
  artifacts: PinnedArtifact[];
  onUnpin: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
}

const TRUNCATE_LENGTH = 200;

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function KeptCard({
  artifact,
  onUnpin,
  onUpdateLabel,
}: {
  artifact: PinnedArtifact;
  onUnpin: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(artifact.label ?? '');

  const needsTruncation = artifact.content.length > TRUNCATE_LENGTH;
  const displayContent = expanded || !needsTruncation
    ? artifact.content
    : artifact.content.slice(0, TRUNCATE_LENGTH) + '\u2026';

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = artifact.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [artifact.content]);

  const handleLabelSave = useCallback(() => {
    onUpdateLabel(artifact.id, labelDraft.trim());
    setEditingLabel(false);
  }, [artifact.id, labelDraft, onUpdateLabel]);

  return (
    <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
      {/* Header row: label / timestamp / actions */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          {editingLabel ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => { e.preventDefault(); handleLabelSave(); }}
            >
              <input
                autoFocus
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={handleLabelSave}
                placeholder="Add a label\u2026"
                className="h-6 flex-1 rounded bg-transparent px-1 text-xs text-push-fg outline-none ring-1 ring-push-edge focus:ring-push-sky/50"
              />
            </form>
          ) : (
            <button
              onClick={() => { setLabelDraft(artifact.label ?? ''); setEditingLabel(true); }}
              className="text-push-xs text-push-fg-dim hover:text-push-fg transition-colors truncate max-w-full text-left"
              title="Click to edit label"
            >
              {artifact.label || 'Untitled reference'}
            </button>
          )}
        </div>
        <span className="shrink-0 text-[10px] text-push-fg-dim/60 tabular-nums">
          {formatTimeAgo(artifact.pinnedAt)}
        </span>
      </div>

      {/* Content */}
      <div className="text-push-sm text-[#d1d8e6] leading-relaxed whitespace-pre-wrap break-words">
        {displayContent}
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-1.5 mt-2">
        {needsTruncation && (
          <button
            onClick={() => setExpanded(!expanded)}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1 px-2`}
          >
            <HubControlGlow />
            {expanded ? (
              <>
                <ChevronUp className="relative z-10 h-3 w-3" />
                <span className="relative z-10">Less</span>
              </>
            ) : (
              <>
                <ChevronDown className="relative z-10 h-3 w-3" />
                <span className="relative z-10">More</span>
              </>
            )}
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
          aria-label={copied ? 'Copied!' : 'Copy content'}
          title={copied ? 'Copied!' : 'Copy content'}
        >
          <HubControlGlow />
          {copied ? (
            <Check className="relative z-10 h-3.5 w-3.5 text-push-status-success" />
          ) : (
            <Copy className="relative z-10 h-3.5 w-3.5" />
          )}
        </button>
        <button
          onClick={() => onUnpin(artifact.id)}
          className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
          aria-label="Remove pin"
          title="Remove pin"
        >
          <HubControlGlow />
          <Trash2 className="relative z-10 h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function HubKeptTab({ artifacts, onUnpin, onUpdateLabel }: HubKeptTabProps) {
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="text-center">
          <Pin className="mx-auto mb-3 h-8 w-8 text-push-fg-dim/40" />
          <p className="text-sm text-push-fg-dim">No references yet</p>
          <p className="mt-1 text-push-xs text-push-fg-dim/60 leading-relaxed max-w-[240px] mx-auto">
            Pin useful replies from chat to keep them nearby in Notes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2.5">
        {artifacts.map((artifact) => (
          <KeptCard
            key={artifact.id}
            artifact={artifact}
            onUnpin={onUnpin}
            onUpdateLabel={onUpdateLabel}
          />
        ))}
      </div>
    </div>
  );
}
