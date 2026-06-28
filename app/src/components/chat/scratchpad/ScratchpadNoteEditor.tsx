import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Trash2, X } from 'lucide-react';
import { useEscapeAndScrollLock } from '@/hooks/use-escape-and-scroll-lock';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { PushMarkdownRenderer } from '@/components/chat/PushMarkdownRenderer';
import type { RepoAppearanceGlowStyleId } from '@/lib/repo-appearance';

type EditorMode = 'edit' | 'preview';

interface ScratchpadNoteEditorProps {
  /** Note name shown in the header — the memory name, or "Working notes". */
  title: string;
  /** Live meta line under the title (e.g. char count, edited-time). */
  subtitle?: string;
  content: string;
  onChange: (content: string) => void;
  onClose: () => void;
  /** Present only for saved memories; the working-notes draft can't be deleted. */
  onDelete?: () => void;
  /**
   * Shared `view-transition-name` with the source card / preview so the browser
   * morphs the tapped surface into this editor (and back on close). `undefined`
   * when the morph isn't available — the panel just mounts in place.
   */
  morphName?: string;
  /**
   * The active repo's ambient glow treatment, so the editor's background matches
   * whatever the repo picked (gradient / dotted / ripple) instead of a hardcoded
   * dot field. `glowEnabled: false` renders no texture at all.
   */
  glowStyle: RepoAppearanceGlowStyleId;
  glowEnabled: boolean;
  /** The repo's resolved accent hex — drives the glow color. */
  accentHex: string;
}

/**
 * Full-screen, keyboard-ready editor for a scratchpad note. Tapping the Working
 * notes field or a saved-note card morphs into this overlay (View Transitions,
 * with an instant fallback) and autofocuses the textarea so the mobile keyboard
 * comes up ready to type. Edits flow straight through `onChange` to the live
 * scratchpad; when a saved memory is the live note the hook writes them back to
 * that memory in place, so this one editor serves both entry points.
 *
 * The ambient background reuses the chat surface's `ChatBackgroundGlow`, fed the
 * repo's own glow style + accent, so the note paper tracks the repo theme (and
 * goes flat when the repo's glow is off). An Edit / Preview toggle renders the
 * note as markdown without leaving the editor.
 */
export function ScratchpadNoteEditor({
  title,
  subtitle,
  content,
  onChange,
  onClose,
  onDelete,
  morphName,
  glowStyle,
  glowEnabled,
  accentHex,
}: ScratchpadNoteEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<EditorMode>('edit');

  useEscapeAndScrollLock(onClose);

  // Bring up the keyboard ready to type: focus the field and drop the caret at
  // the end of the existing text. `preventScroll` keeps the morph from being
  // yanked by a focus-induced scroll. Runs on mount (mode starts 'edit') and
  // again whenever we flip back from Preview to Edit so the field that just
  // mounted regains focus. Guarded so it no-ops while the textarea is unmounted
  // in Preview. `autoFocus` is the no-JS fallback for the same intent.
  useEffect(() => {
    if (mode !== 'edit') return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [mode]);

  const hasContent = content.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[130] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Editing note: ${title}`}
    >
      <button
        type="button"
        aria-label="Close editor"
        onClick={onClose}
        className="scratch-overlay-backdrop absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
      />
      <div
        style={{ viewTransitionName: morphName } as CSSProperties}
        className="scratch-overlay-panel relative z-10 isolate flex h-full w-full flex-col overflow-hidden"
      >
        {/* Opaque base so the full-screen overlay never shows the dimmed page
            through it; the glow paints above it but below the content. */}
        <div className="absolute inset-0 -z-20 bg-push-surface-raised" />
        <ChatBackgroundGlow active={glowEnabled} color={accentHex} variant={glowStyle} />

        <header className="relative border-b border-push-edge px-4 py-3">
          <div className="mx-auto flex w-full max-w-[760px] items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-push-fg">{title}</p>
              {subtitle && <p className="mt-0.5 text-push-2xs text-push-fg-dim">{subtitle}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div
                role="tablist"
                aria-label="Editor mode"
                className="flex items-center rounded-full border border-push-edge bg-black/20 p-0.5 text-push-2xs"
              >
                <ModeTab label="Edit" active={mode === 'edit'} onClick={() => setMode('edit')} />
                <ModeTab
                  label="Preview"
                  active={mode === 'preview'}
                  onClick={() => setMode('preview')}
                />
              </div>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Delete note"
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-push-edge bg-black/20 text-push-fg-dim transition-colors hover:border-red-500/40 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close editor"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-push-edge bg-black/20 text-push-fg-dim transition-colors hover:text-push-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col min-h-0">
            {mode === 'edit' ? (
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
                placeholder="Capture notes, requirements, and the pieces you want the model to keep in mind…"
                className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3.5 text-[15px] leading-relaxed text-push-fg outline-none placeholder:text-push-fg-dim"
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 text-[15px] leading-relaxed text-push-fg">
                {hasContent ? (
                  <PushMarkdownRenderer text={content} isStreaming={false} />
                ) : (
                  <p className="text-push-fg-dim">Nothing to preview yet.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
        active ? 'bg-push-surface-raised text-push-fg' : 'text-push-fg-dim hover:text-push-fg'
      }`}
    >
      {label}
    </button>
  );
}
