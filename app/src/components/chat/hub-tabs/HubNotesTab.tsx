import { useState, type CSSProperties } from 'react';
import { Check, Download, Maximize2, Trash2 } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { PinnedArtifact } from '@/hooks/usePinnedArtifacts';
import type { TodoItem } from '@/lib/todo-tools';
import { runViewTransition } from '@/lib/view-transition';
import { timeAgoCompact } from '@/lib/utils';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_TAG_CLASS,
} from '@/components/chat/hub-styles';
import { KeptCacheIcon, NotebookPadIcon } from '@/components/icons/push-custom-icons';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import { ScratchpadMemoryGallery } from '@/components/chat/scratchpad/ScratchpadMemoryGallery';
import { ScratchpadNoteEditor } from '@/components/chat/scratchpad/ScratchpadNoteEditor';
import { cardViewTransitionName } from '@/components/chat/scratchpad/scratchpad-morph';
import { Tip } from '@/components/Tip';
import { HubKeptTab } from './HubKeptTab';

// Morph name for the Working notes preview ↔ full-screen editor transition. The
// preview surrenders it to the editor panel while open (one element per name).
const WORKING_NOTES_MORPH = 'scratch-working-notes';

// Which note the editor is bound to: the unsaved draft (`memoryId: null`) or a
// saved memory. `morph` is the source surface's view-transition-name so the
// editor morphs out of, and back into, whatever was tapped.
interface NoteEditorTarget {
  memoryId: string | null;
  morph: string;
}

interface HubNotesTabProps {
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onContentChange: (content: string) => void;
  onClear: () => void;
  onSaveMemory: (name: string) => void;
  onLoadMemory: (id: string | null) => void;
  onDeleteMemory: (id: string) => void;
  onExportToRepo?: () => void;
  sandboxId: string | null;
  artifacts: PinnedArtifact[];
  onUnpin: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
  todos: readonly TodoItem[];
  onTodoClear: () => void;
  /**
   * The active repo's appearance + resolved accent hex, so the full-screen note
   * editor's ambient background matches the repo theme. Defaults to Push's
   * canonical sky/gradient when no repo theme applies (e.g. the scratch repo).
   */
  appearance?: RepoAppearance;
  accentHex?: string;
}

export function HubNotesTab({
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onContentChange,
  onClear,
  onSaveMemory,
  onLoadMemory,
  onDeleteMemory,
  onExportToRepo,
  sandboxId,
  artifacts,
  onUnpin,
  onUpdateLabel,
  todos,
  onTodoClear,
  appearance = DEFAULT_REPO_APPEARANCE,
  accentHex,
}: HubNotesTabProps) {
  const [memoryName, setMemoryName] = useState('');
  const [editor, setEditor] = useState<NoteEditorTarget | null>(null);
  // Prefer the caller's resolved accent; fall back to the appearance's own color
  // so the editor glow always has a concrete hex even without an explicit accent.
  const resolvedAccentHex = accentHex ?? getRepoAppearanceColorHex(appearance.color);
  const activeMemory = activeMemoryId
    ? (scratchpadMemories.find((memory) => memory.id === activeMemoryId) ?? null)
    : null;

  // Tapping the Working notes field edits whatever is live — the unsaved draft
  // or, if a memory is loaded, that memory in place. The field is the morph
  // source, so it claims WORKING_NOTES_MORPH.
  const openLiveEditor = () =>
    runViewTransition(() => setEditor({ memoryId: activeMemoryId, morph: WORKING_NOTES_MORPH }));

  // Tapping a saved card loads it as the live note, then morphs that card into
  // the editor. Edits write through to the memory in place (see useScratchpad).
  const openMemoryEditor = (memory: ScratchpadMemory) =>
    runViewTransition(() => {
      onLoadMemory(memory.id);
      setEditor({ memoryId: memory.id, morph: cardViewTransitionName(memory.id) });
    });

  const closeEditor = () => runViewTransition(() => setEditor(null));

  const deleteFromEditor = (id: string) =>
    runViewTransition(() => {
      onDeleteMemory(id);
      setEditor(null);
    });

  const editorMemory =
    editor && editor.memoryId
      ? (scratchpadMemories.find((memory) => memory.id === editor.memoryId) ?? null)
      : null;
  const editorTitle = editorMemory ? editorMemory.name : 'Working notes';
  const editorSubtitle = editorMemory
    ? `Edited ${timeAgoCompact(editorMemory.updatedAt)} · ${scratchpadContent.length} chars`
    : `${scratchpadContent.length} chars · the model sees these notes`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex min-h-full flex-col gap-4">
          <section
            className={`flex min-h-[320px] flex-[1.55] flex-col gap-3 p-3.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <NotebookPadIcon className="h-4 w-4 text-push-fg-dim" />
                  <p className="text-sm font-medium text-push-fg">Working notes</p>
                  <span className={HUB_TAG_CLASS}>live context</span>
                </div>
                <p className="mt-1 text-push-xs text-push-fg-dim">
                  The model sees these notes on each reply, so keep only what you want in play.
                </p>
                {activeMemory && (
                  <p className="mt-2 text-push-2xs text-push-fg-dim">
                    Loaded memory:{' '}
                    <span className="text-push-fg-secondary">{activeMemory.name}</span>
                  </p>
                )}
              </div>
              {scratchpadMemories.length > 0 && (
                <span className="shrink-0 text-push-2xs text-push-fg-dim">
                  {scratchpadMemories.length} saved
                </span>
              )}
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={memoryName}
                  onChange={(event) => setMemoryName(event.target.value)}
                  placeholder="Name this note"
                  className={`${HUB_MATERIAL_INPUT_CLASS} min-w-[150px] flex-1`}
                />
                <Tip content="Save current notes as a memory">
                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = memoryName.trim();
                      if (!trimmed) return;
                      onSaveMemory(trimmed);
                      setMemoryName('');
                    }}
                    disabled={!scratchpadContent.trim() || !memoryName.trim()}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>Save note</span>
                  </button>
                </Tip>
                <Tip content="Clear notes" suppressClickAfterLongPress>
                  <button
                    type="button"
                    onClick={onClear}
                    disabled={!scratchpadContent.trim()}
                    className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
                    aria-label="Clear notes"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Tip>
                {onExportToRepo ? (
                  <button
                    type="button"
                    onClick={onExportToRepo}
                    disabled={!scratchpadContent.trim() || !sandboxId}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
                    aria-label="Save notes to repo"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Save to repo</span>
                  </button>
                ) : null}
              </div>

              {scratchpadMemories.length > 0 && (
                <div className="mt-2.5">
                  <ScratchpadMemoryGallery
                    memories={scratchpadMemories}
                    activeMemoryId={activeMemoryId}
                    openMemoryId={editor?.memoryId ?? null}
                    onLoad={onLoadMemory}
                    onOpenMemory={openMemoryEditor}
                  />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={openLiveEditor}
              style={
                { viewTransitionName: editor ? undefined : WORKING_NOTES_MORPH } as CSSProperties
              }
              aria-label="Edit notes full screen"
              className="relative min-h-[240px] flex-1 overflow-hidden rounded-xl border border-push-edge-subtle bg-push-surface-inset px-3 py-2.5 text-left shadow-push-inset transition-colors hover:border-push-edge-hover focus:border-push-sky/50 focus:outline-none"
            >
              <Maximize2 className="pointer-events-none absolute right-2.5 top-2.5 h-3.5 w-3.5 text-push-fg-dim" />
              {scratchpadContent.trim() ? (
                <span className="block whitespace-pre-wrap break-words pr-6 text-sm leading-relaxed text-push-fg">
                  {scratchpadContent}
                </span>
              ) : (
                <span className="block pr-6 text-sm leading-relaxed text-push-fg-dim">
                  Capture notes, requirements, and the pieces you want the model to keep in mind…
                </span>
              )}
            </button>
          </section>

          <HubTodoSection todos={todos} onClear={onTodoClear} />

          <section
            className={`flex min-h-[220px] flex-[0.85] flex-col gap-3 p-3.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <KeptCacheIcon className="h-4 w-4 text-push-fg-dim" />
                  <p className="text-sm font-medium text-push-fg">Pinned references</p>
                  <span className={HUB_TAG_CLASS}>reference only</span>
                </div>
                <p className="mt-1 text-push-xs text-push-fg-dim">
                  Useful snippets and outputs you want nearby without adding them to the prompt.
                </p>
              </div>
              <span className="shrink-0 text-push-2xs text-push-fg-dim">
                {artifacts.length} {artifacts.length === 1 ? 'reference' : 'references'}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <HubKeptTab artifacts={artifacts} onUnpin={onUnpin} onUpdateLabel={onUpdateLabel} />
            </div>
          </section>
        </div>
      </div>

      {editor && (
        <ScratchpadNoteEditor
          title={editorTitle}
          subtitle={editorSubtitle}
          content={scratchpadContent}
          onChange={onContentChange}
          onClose={closeEditor}
          onDelete={editor.memoryId ? () => deleteFromEditor(editor.memoryId as string) : undefined}
          morphName={editor.morph}
          glowStyle={appearance.glowStyle}
          glowEnabled={appearance.glowEnabled}
          accentHex={resolvedAccentHex}
        />
      )}
    </div>
  );
}

/**
 * Read-only display of the model's current step plan. Intentionally passive:
 * the todo list is the model's working memory, not a user task list, so the
 * UI shows what the model is tracking and offers a Clear to reset — nothing
 * else. If the user wants to change the plan, they ask the model to rewrite
 * it via todo_write.
 */
function HubTodoSection({ todos, onClear }: { todos: readonly TodoItem[]; onClear: () => void }) {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const hasItems = todos.length > 0;

  return (
    <section
      className={`flex flex-col gap-3 p-3.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
      aria-label="Model plan"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-push-fg">Plan</p>
            <span className={HUB_TAG_CLASS}>model's steps</span>
          </div>
          <p className="mt-1 text-push-xs text-push-fg-dim">
            What the model is tracking for the current effort. Ask it to rewrite this if the plan
            needs to change.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasItems && (
            <span className="text-push-2xs text-push-fg-dim">
              {done} of {todos.length} done
            </span>
          )}
          <Tip content="Clear plan" suppressClickAfterLongPress>
            <button
              type="button"
              onClick={onClear}
              disabled={!hasItems}
              className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
              aria-label="Clear plan"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tip>
        </div>
      </div>

      {hasItems ? (
        <ul className="flex flex-col gap-1.5">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-2 text-push-xs">
              <StatusMarker status={todo.status} />
              <span
                className={
                  todo.status === 'completed'
                    ? 'flex-1 text-push-fg-dim line-through'
                    : 'flex-1 text-push-fg'
                }
              >
                {todo.status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-push-2xs text-push-fg-dim">
          No plan yet — the model will populate this when it starts a multi-step task.
        </p>
      )}
    </section>
  );
}

function StatusMarker({ status }: { status: TodoItem['status'] }) {
  const shared = 'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm';
  if (status === 'completed') {
    return (
      <span
        className={`${shared} border border-push-fg-dim/50 bg-push-fg-dim/30`}
        aria-label="completed"
      >
        <Check className="h-2.5 w-2.5 text-push-fg" />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className={`${shared} border border-push-sky bg-push-sky/20`} aria-label="in progress">
        <span className="h-1.5 w-1.5 rounded-full bg-push-sky" />
      </span>
    );
  }
  return <span className={`${shared} border border-push-edge`} aria-label="pending" />;
}
