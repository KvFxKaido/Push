import { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronsUpDown, Loader2, Lock, RefreshCw, Square } from 'lucide-react';
import { toast } from 'sonner';
import { AttachmentPreview } from './AttachmentPreview';
import { ContextMeter } from './ContextMeter';
import { LibraryPanel } from './LibraryPanel';
import { LinkedLibraryChips } from './LinkedLibraryChips';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelPicker } from '@/components/ui/model-picker';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useIsMobile } from '@/hooks/use-mobile';
import { ACCEPTED_FILE_TYPES, processFile, getTotalAttachmentSize } from '@/lib/file-processing';
import type { StagedAttachment } from '@/lib/file-processing';
import { getVisionCapabilityNotice } from '@/lib/model-capabilities';
import {
  getModelCapabilities,
  getReasoningEffort,
  cycleReasoningEffort,
  REASONING_EFFORT_LABELS,
  type ReasoningEffort,
} from '@/lib/model-catalog';
import type { AIProviderType, AttachmentData, ChatSendOptions } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import {
  MODEL_LOCKED_MESSAGE,
  type ComposerPickerModelControl,
  type ComposerProviderControls,
} from '@/lib/composer-provider-controls';
import { hapticLight } from '@/lib/android/haptics';
import {
  AttachmentLinkIcon,
  SendLiftIcon,
  VoicePulseIcon,
} from '@/components/icons/push-custom-icons';
import { getProviderDisplayName } from '@push/lib/provider-definition';

interface ChatInputProps {
  onSend: (message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  /**
   * Hard-disable the composer — blocks the textarea, attachments, and
   * send button. Used by daemon screens to gate sends while the
   * transport binding isn't open (so the user's draft isn't silently
   * dropped into the cleared textarea after a click that couldn't
   * route anywhere).
   */
  disabled?: boolean;
  queuedFollowUpCount?: number;
  pendingSteerCount?: number;
  repoName?: string;
  placeholder?: string;
  contextUsage?: { used: number; max: number; percent: number };
  /** When true, render the Library button that lets the user attach
   *  previously-saved files. Chat mode opts in; workspace mode keeps the
   *  repo as its persistence layer. */
  libraryEnabled?: boolean;
  /** Library v2b — IDs of libraries linked to the current chat. Used to
   *  show the chip strip above the composer and to gate the Link
   *  toggle's state in the picker detail view. */
  linkedLibraryIds?: readonly string[];
  /** Library v2b — replace the linked-library set on the current chat.
   *  Undefined when no active chat exists (e.g. pre-flight composer);
   *  the Link toggle stays disabled in that case. */
  onSetLinkedLibraries?: (nextIds: readonly string[]) => void;
  draftKey?: string | null;
  prefillRequest?: {
    token: number;
    text: string;
    attachments?: AttachmentData[];
  } | null;
  editState?: {
    label: string;
    onCancel: () => void;
  } | null;
  providerControls?: ComposerProviderControls;
}

const MAX_PAYLOAD = 750 * 1024; // 750KB total
const COMPOSER_DRAFT_KEY_PREFIX = 'push:chat-composer-draft:';

function formatTimeAgo(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const COMPOSER_CONTROL_SURFACE_CLASS =
  'relative overflow-hidden rounded-full border border-push-edge-subtle bg-push-grad-input shadow-[0_12px_34px_rgba(0,0,0,0.5),0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur-xl';
const COMPOSER_CONTROL_INTERACTIVE_CLASS =
  'transition-all duration-200 hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 spring-press';

function composerDraftStorageKey(draftKey: string): string {
  return `${COMPOSER_DRAFT_KEY_PREFIX}${draftKey}`;
}

function parseSavedDraft(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === 'string' ? parsed.value : '';
  } catch {
    return '';
  }
}

function toStagedAttachments(attachments?: AttachmentData[]): StagedAttachment[] {
  return (attachments || []).map((attachment) => ({
    ...attachment,
    status: 'ready',
  }));
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  queuedFollowUpCount = 0,
  pendingSteerCount = 0,
  repoName,
  placeholder,
  contextUsage,
  libraryEnabled,
  linkedLibraryIds,
  onSetLinkedLibraries,
  draftKey,
  prefillRequest,
  editState,
  providerControls,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isMobile = useIsMobile();

  const speechSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Only process results from resultIndex onward — earlier entries are
      // already in the textarea. The Web Speech API's results list is cumulative.
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        setValue((prev) => (prev ? prev + ' ' + transcript.trim() : transcript.trim()));
      }
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      // 'aborted' = user stopped; 'no-speech' = benign silence timeout. Both are
      // expected and shouldn't nag. Everything else is a real failure the user
      // can't otherwise see, so name it instead of swallowing it.
      // Non-standard browsers may dispatch a generic Event lacking `error`.
      const code = event?.error;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'speech_recognition_error',
          code,
          message: event?.message,
        }),
      );
      if (code === 'aborted' || code === 'no-speech') return;
      const message =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone access is blocked. Enable it for this site in your browser settings.'
          : code === 'audio-capture'
            ? 'No microphone was found.'
            : code === 'network'
              ? 'Voice input needs a network connection.'
              : 'Voice input failed. Please try again.';
      toast.error(message);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const hasAttachments = stagedAttachments.length > 0;
  const readyAttachments = stagedAttachments.filter((a) => a.status === 'ready');
  const hasDraftContent = value.trim().length > 0 || readyAttachments.length > 0;
  const canSendBase = hasDraftContent && !isStreaming && !disabled;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 22;
    const maxLines = 4;
    const maxHeight = lineHeight * maxLines + 20;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const nextValue = draftKey
        ? parseSavedDraft(safeStorageGet(composerDraftStorageKey(draftKey)))
        : '';
      setValue(nextValue);
      setStagedAttachments([]);
    });

    return () => cancelAnimationFrame(frame);
  }, [draftKey, adjustHeight]);

  useEffect(() => {
    if (!draftKey) return;
    const storageKey = composerDraftStorageKey(draftKey);
    if (!value) {
      safeStorageRemove(storageKey);
      return;
    }
    safeStorageSet(storageKey, JSON.stringify({ value }));
  }, [draftKey, value]);

  useEffect(() => {
    if (!prefillRequest) return;

    const frame = requestAnimationFrame(() => {
      setValue(prefillRequest.text);
      setStagedAttachments(toStagedAttachments(prefillRequest.attachments));

      requestAnimationFrame(() => {
        adjustHeight();
        textareaRef.current?.focus();
        const cursor = prefillRequest.text.length;
        textareaRef.current?.setSelectionRange(cursor, cursor);
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [prefillRequest, adjustHeight]);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      // Check total size before processing
      const currentSize = getTotalAttachmentSize(stagedAttachments);
      let addedSize = 0;

      for (const file of Array.from(files)) {
        if (currentSize + addedSize + file.size > MAX_PAYLOAD * 1.5) {
          // Skip files that would exceed limit (with some headroom for base64)
          continue;
        }

        // Add placeholder while processing
        const placeholder: StagedAttachment = {
          id: crypto.randomUUID(),
          type: 'document',
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          content: '',
          status: 'processing',
        };
        setStagedAttachments((prev) => [...prev, placeholder]);

        // Process file
        const processed = await processFile(file);
        setStagedAttachments((prev) =>
          prev.map((a) => (a.id === placeholder.id ? { ...processed, id: placeholder.id } : a)),
        );

        addedSize += processed.content.length;
      }

      // Clear input so same file can be selected again
      e.target.value = '';
    },
    [stagedAttachments],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleAttachFromLibrary = useCallback((attachments: StagedAttachment[]) => {
    setStagedAttachments((prev) => {
      // Respect the same cumulative size budget as direct uploads.
      let currentSize = getTotalAttachmentSize(prev);
      const accepted: StagedAttachment[] = [];
      for (const att of attachments) {
        const size = att.content.length || att.sizeBytes || 0;
        if (currentSize + size > MAX_PAYLOAD * 1.5) continue;
        accepted.push(att);
        currentSize += size;
      }
      return [...prev, ...accepted];
    });
  }, []);

  const handleButtonClick = () => {
    if (isStreaming && !canStreamWithDraft) {
      onStop?.();
    } else {
      handleSend(isStreaming ? 'steer' : undefined);
    }
  };

  const selectedProvider: AIProviderType = (() => {
    if (!providerControls) return 'demo';
    if (providerControls.isProviderLocked && providerControls.lockedProvider)
      return providerControls.lockedProvider;
    if (providerControls.selectedProvider) return providerControls.selectedProvider;
    return providerControls.availableProviders[0]?.[0] ?? 'demo';
  })();

  const isDisplayedProviderLocked = Boolean(
    providerControls?.isProviderLocked &&
      providerControls.lockedProvider &&
      providerControls.lockedProvider === selectedProvider,
  );

  const selectedModelControl =
    providerControls && selectedProvider !== 'demo'
      ? providerControls.modelControls[selectedProvider]
      : undefined;

  const selectedModel =
    isDisplayedProviderLocked && providerControls?.lockedModel
      ? providerControls.lockedModel
      : (selectedModelControl?.value ?? (selectedProvider === 'demo' ? 'demo' : ''));

  const canChangeProvider = Boolean(providerControls);
  const canChangeModel = Boolean(providerControls);
  const backendValues = providerControls?.availableProviders.map(([value]) => value) ?? [];
  const selectedBackendValue = backendValues.includes(selectedProvider as PreferredProvider)
    ? (selectedProvider as PreferredProvider)
    : (backendValues[0] ?? '');

  const selectedPickerControl =
    selectedModelControl?.kind === 'picker' ? selectedModelControl : undefined;
  const selectedModelLoading = Boolean(selectedPickerControl?.loading);
  const selectedModelUpdatedAgo = formatTimeAgo(selectedPickerControl?.updatedAt ?? null);
  const canRefreshSelectedModelList = Boolean(selectedPickerControl?.refreshModels);
  const refreshSelectedModelList = () => {
    selectedPickerControl?.refreshModels?.();
  };
  // Reasoning effort (per-provider, only for models that support it)
  const modelCaps = getModelCapabilities(selectedProvider, selectedModel);
  const [reasoningEffortState, setReasoningEffortState] = useState<{
    provider: AIProviderType;
    effort: ReasoningEffort;
  }>(() => ({
    provider: selectedProvider,
    effort: getReasoningEffort(selectedProvider),
  }));
  const reasoningEffort =
    reasoningEffortState.provider === selectedProvider
      ? reasoningEffortState.effort
      : getReasoningEffort(selectedProvider);

  const handleCycleReasoning = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Don't open the popover
      const next = cycleReasoningEffort(selectedProvider);
      setReasoningEffortState({ provider: selectedProvider, effort: next });
    },
    [selectedProvider],
  );

  // Display model name: strip provider prefix for OpenRouter, use as-is for others
  const displayModelName = selectedModel.replace(/^[^/]+\//, '');

  const renderModelLockedMessage = (control: { isLocked: boolean; lockedMessage?: string }) =>
    control.isLocked ? (
      <p className="px-1 text-push-2xs text-amber-400">
        {control.lockedMessage ?? MODEL_LOCKED_MESSAGE}
      </p>
    ) : null;

  const renderPickerModelControl = (control: ComposerPickerModelControl) => {
    const options =
      control.options.length > 0 || !control.value ? control.options : [control.value];
    return (
      <>
        <ModelPicker
          provider={control.provider}
          value={control.value}
          options={options}
          onChange={control.onChange}
          disabled={!canChangeModel || Boolean(control.loading)}
          ariaLabel={control.ariaLabel}
          allowCustom={control.allowCustom}
          customPlaceholder={control.customPlaceholder}
          triggerLabel={control.triggerLabel}
          triggerTrailing={control.triggerTrailing}
        />
        {control.loading && (
          <p className="px-1 text-push-2xs text-push-fg-faint">
            {control.loadingLabel ??
              `Loading ${getProviderDisplayName(control.provider)} models...`}
          </p>
        )}
        {!control.loading &&
          control.options.length === 0 &&
          !control.error &&
          control.refreshModels && (
            <p className="px-1 text-push-2xs text-push-fg-faint">
              No models returned. Try refresh.
            </p>
          )}
        {control.error && <p className="px-1 text-push-2xs text-amber-400">{control.error}</p>}
        {selectedModelUpdatedAgo && (
          <p className="px-1 text-push-2xs text-push-fg-faint">Updated {selectedModelUpdatedAgo}</p>
        )}
        {control.footer && (
          <p className="px-1 text-push-2xs text-push-fg-faint">{control.footer}</p>
        )}
        {renderModelLockedMessage(control)}
      </>
    );
  };

  const renderSelectedModelControl = () => {
    if (selectedProvider === 'demo') {
      return (
        <div className="rounded-lg border border-push-edge-hover bg-push-surface px-2.5 py-2 text-push-xs text-push-fg-secondary">
          Demo mode (no model selection)
        </div>
      );
    }
    if (!selectedModelControl) {
      return (
        <div className="rounded-lg border border-push-edge-hover bg-push-surface px-2.5 py-2 text-push-xs text-push-fg-secondary">
          No model selector is registered for {getProviderDisplayName(selectedProvider)}.
        </div>
      );
    }
    return renderPickerModelControl(selectedModelControl);
  };

  const readyImageAttachments = readyAttachments.filter(
    (attachment) => attachment.type === 'image',
  );
  const visionNotice = getVisionCapabilityNotice(selectedProvider, selectedModel);
  const hasUnsupportedImageAttachments =
    readyImageAttachments.length > 0 && visionNotice.support === 'unsupported';
  const hasUnknownImageSupport =
    readyImageAttachments.length > 0 && visionNotice.support === 'unknown';
  const canSend = canSendBase && !hasUnsupportedImageAttachments;
  const canStreamWithDraft =
    Boolean(isStreaming) && hasDraftContent && !hasUnsupportedImageAttachments && !disabled;

  const handleSend = (streamingBehavior?: ChatSendOptions['streamingBehavior']) => {
    if (!canSend && !canStreamWithDraft) return;

    const attachments: AttachmentData[] = readyAttachments.map(
      ({ id, type, filename, mimeType, sizeBytes, content, thumbnail }) => ({
        id,
        type,
        filename,
        mimeType,
        sizeBytes,
        content,
        thumbnail,
      }),
    );

    // Light tap on a real send — the native "it's away" cue (no-op on web).
    hapticLight();
    onSend(
      value.trim(),
      attachments.length > 0 ? attachments : undefined,
      streamingBehavior ? { streamingBehavior } : undefined,
    );
    setValue('');
    setStagedAttachments([]);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  };

  const sendButtonLabel = isStreaming
    ? canStreamWithDraft
      ? 'Steer current run'
      : 'Stop generating'
    : hasUnsupportedImageAttachments
      ? 'Selected model cannot read image attachments'
      : editState
        ? 'Save edit and resend'
        : 'Send message';

  const statusNotice = (() => {
    if (isStreaming) {
      if (hasUnsupportedImageAttachments) {
        return {
          tone: 'error' as const,
          text: `${visionNotice.text} Remove the image attachment${readyImageAttachments.length > 1 ? 's' : ''} to queue this follow-up.`,
        };
      }
      if (canStreamWithDraft) {
        const queueText =
          queuedFollowUpCount > 0
            ? `Queue waits behind ${queuedFollowUpCount} queued follow-up${queuedFollowUpCount === 1 ? '' : 's'}.`
            : 'Queue waits until the current run finishes.';
        return {
          tone: 'default' as const,
          text: `Send steers the next turn. ${queueText}`,
        };
      }
      if (pendingSteerCount > 0) {
        return {
          tone: 'default' as const,
          text: 'Steering update captured. It will apply after the current step.',
        };
      }
      if (queuedFollowUpCount > 0) {
        return {
          tone: 'default' as const,
          text: `${queuedFollowUpCount} follow-up${queuedFollowUpCount === 1 ? '' : 's'} queued`,
        };
      }
      return {
        tone: 'default' as const,
        text: 'Generating... Draft a steer or clear the composer to stop.',
      };
    }
    if (hasUnsupportedImageAttachments) {
      return {
        tone: 'error' as const,
        text: `${visionNotice.text} Switch models or remove the image attachment${readyImageAttachments.length > 1 ? 's' : ''}.`,
      };
    }
    if (hasUnknownImageSupport) {
      return {
        tone: 'warning' as const,
        text: `${visionNotice.text} It may still work, but this model is not verified yet.`,
      };
    }
    if (readyAttachments.length > 0) {
      return {
        tone: 'default' as const,
        text: `${readyAttachments.length} attachment${readyAttachments.length > 1 ? 's' : ''} ready`,
      };
    }
    return null;
  })();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Only use mobile keyboard behavior (Enter = newline) if BOTH:
    // 1. Narrow viewport (mobile layout) AND
    // 2. Touch capability (actual touch device)
    // This prevents desktop users with narrow windows from losing Enter-to-send
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isMobileDevice = isMobile && hasTouch;

    if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
      e.preventDefault();
      if (isStreaming && !canStreamWithDraft) {
        onStop?.();
      } else {
        handleSend(isStreaming ? 'steer' : undefined);
      }
    }
  };

  return (
    <div className="safe-area-bottom sticky bottom-0 z-10 px-3 pb-3 mx-auto w-full max-w-2xl">
      <div className="relative overflow-hidden rounded-[24px] border border-push-edge-subtle/90 bg-push-grad-input shadow-[0_12px_40px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white/[0.03] to-transparent" />

        {editState && (
          <div className="px-3 pt-3">
            <div className="flex items-center justify-between gap-3 rounded-[18px] border border-amber-500/20 [background-image:var(--push-surface-warning)] px-3.5 py-2.5">
              <p className="text-xs text-amber-100/90">{editState.label}</p>
              <button
                type="button"
                onClick={editState.onCancel}
                className="rounded-full px-2.5 py-1 text-push-2xs text-amber-100/70 transition-colors hover:bg-white/[0.06] hover:text-amber-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Linked libraries (v2b) — auto-attach every turn until unlinked */}
        {libraryEnabled && linkedLibraryIds && linkedLibraryIds.length > 0 && (
          <LinkedLibraryChips
            libraryIds={linkedLibraryIds}
            onUnlink={(id) => {
              if (!onSetLinkedLibraries) return;
              onSetLinkedLibraries(linkedLibraryIds.filter((existing) => existing !== id));
            }}
          />
        )}

        {/* Attachment preview */}
        {hasAttachments && (
          <div className="px-3 pt-3">
            <AttachmentPreview attachments={stagedAttachments} onRemove={handleRemoveAttachment} />
          </div>
        )}

        {/* Text input */}
        <div className="px-3 pt-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              placeholder ?? (repoName ? `Ask about ${repoName}...` : 'Ask about code...')
            }
            rows={1}
            disabled={disabled}
            className="w-full resize-none overflow-y-auto bg-transparent px-1 pb-2 text-push-lg leading-6 text-push-fg placeholder:text-push-fg-dim focus:outline-none disabled:opacity-60"
          />
        </div>

        <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-1.5">
          <div className="flex shrink-0 items-center gap-2">
            {/* File attachment button */}
            {speechSupported && (
              <button
                type="button"
                onClick={toggleListening}
                className={`flex h-10 w-10 items-center justify-center rounded-full border ${
                  isListening
                    ? `${COMPOSER_CONTROL_SURFACE_CLASS} border-red-400/50 text-red-400 ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                    : `${COMPOSER_CONTROL_SURFACE_CLASS} text-push-fg-secondary ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                }`}
                aria-label={isListening ? 'Stop listening' : 'Voice input'}
                title={isListening ? 'Stop listening' : 'Voice input'}
              >
                <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
                <VoicePulseIcon className="relative z-10 h-4 w-4" />
                {isListening && (
                  <span className="absolute top-1.5 right-1.5 z-20 h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`flex h-10 w-10 items-center justify-center rounded-full border text-push-fg-secondary ${`${COMPOSER_CONTROL_SURFACE_CLASS} ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`}`}
              aria-label="Attach file"
              title="Attach file"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
              <AttachmentLinkIcon className="relative z-10 h-4 w-4" />
            </button>

            {libraryEnabled && (
              <LibraryPanel
                disabled={isStreaming}
                onAttach={handleAttachFromLibrary}
                linkedLibraryIds={linkedLibraryIds}
                onSetLinkedLibraries={onSetLinkedLibraries}
                buttonClassName={`flex h-10 w-10 items-center justify-center rounded-full border text-push-fg-secondary ${COMPOSER_CONTROL_SURFACE_CLASS} ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`}
                iconClassName="relative z-10 h-4 w-4"
              />
            )}

            {providerControls && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`flex h-10 max-w-[188px] items-center gap-2 px-3 text-push-xs text-push-fg-secondary ${COMPOSER_CONTROL_SURFACE_CLASS} ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`}
                    title={
                      isDisplayedProviderLocked
                        ? `${getProviderDisplayName(selectedProvider)} locked for this chat`
                        : 'Backend and model'
                    }
                  >
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
                    <ProviderIcon
                      provider={selectedProvider}
                      size={14}
                      className="relative z-10 shrink-0"
                    />
                    {modelCaps.reasoning && (
                      <button
                        type="button"
                        onClick={handleCycleReasoning}
                        className="relative z-10 shrink-0 rounded border border-push-edge bg-push-surface/60 px-1 py-px text-push-2xs font-medium text-push-fg-dim hover:text-push-fg-secondary active:scale-95 transition-all"
                        title={`Reasoning: ${reasoningEffort} (tap to change)`}
                      >
                        {REASONING_EFFORT_LABELS[reasoningEffort]}
                      </button>
                    )}
                    <span className="relative z-10 truncate">{displayModelName}</span>
                    {isDisplayedProviderLocked ? (
                      <Lock className="relative z-10 h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronsUpDown className="relative z-10 h-3 w-3 shrink-0" />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={10}
                  className="w-[250px] rounded-xl border border-push-edge bg-push-grad-panel p-2.5 text-push-fg-soft shadow-[0_12px_36px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] animate-fade-in"
                >
                  <div className="space-y-2.5 px-1 py-1">
                    <div className="rounded-lg border border-push-edge-hover bg-push-surface px-2.5 py-1.5">
                      <p className="text-push-2xs text-push-fg-muted">
                        {isDisplayedProviderLocked ? 'Current chat: locked' : 'This chat selection'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="px-1 text-push-2xs font-medium uppercase tracking-wide text-push-fg-faint">
                        Backend
                      </p>
                      {providerControls.availableProviders.length === 0 ? (
                        <div className="rounded-lg border border-push-edge-hover bg-push-surface px-2.5 py-2 text-push-xs text-push-fg-faint">
                          No API keys configured yet.
                        </div>
                      ) : (
                        <select
                          value={selectedBackendValue}
                          disabled={!canChangeProvider}
                          onChange={(e) =>
                            providerControls.onSelectBackend(e.target.value as PreferredProvider)
                          }
                          className="h-8 w-full rounded-lg border border-push-edge-hover bg-push-surface px-2.5 text-xs text-push-fg-soft outline-none focus:border-push-edge-focus disabled:opacity-60"
                        >
                          {providerControls.availableProviders.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                              {value === 'zen' ? ' (Recommended)' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-1">
                        <p className="text-push-2xs font-medium uppercase tracking-wide text-push-fg-faint">
                          Model
                        </p>
                        {canRefreshSelectedModelList && (
                          <button
                            type="button"
                            onClick={refreshSelectedModelList}
                            disabled={selectedModelLoading}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-push-edge-hover bg-push-surface text-push-fg-muted transition-colors hover:text-push-fg-soft disabled:opacity-50"
                            aria-label="Refresh models"
                            title="Refresh models"
                          >
                            {selectedModelLoading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                          </button>
                        )}
                      </div>

                      {renderSelectedModelControl()}
                    </div>
                    <p className="px-1 text-push-2xs text-push-fg-faint">
                      Settings controls your defaults. This picker only changes the selected
                      backend/model for this chat.
                    </p>
                    <p
                      className={`px-1 text-push-2xs ${
                        visionNotice.support === 'supported'
                          ? 'text-emerald-400'
                          : visionNotice.support === 'unsupported'
                            ? 'text-amber-400'
                            : 'text-push-fg-faint'
                      }`}
                    >
                      {visionNotice.text}
                    </p>
                    {isDisplayedProviderLocked && (
                      <p className="px-1 text-push-2xs text-amber-400">
                        Changing backend/model here will start a new chat.
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          <div className="min-w-0 flex-1 px-1">
            {statusNotice ? (
              <p
                className={`truncate text-xs ${
                  statusNotice.tone === 'error'
                    ? 'text-red-400'
                    : statusNotice.tone === 'warning'
                      ? 'text-amber-400'
                      : 'text-push-fg-faint'
                }`}
              >
                {statusNotice.text}
              </p>
            ) : contextUsage && contextUsage.percent >= 5 ? (
              <ContextMeter {...contextUsage} />
            ) : null}
          </div>

          {canStreamWithDraft && (
            <button
              type="button"
              onClick={() => handleSend('queue')}
              className={`flex h-10 shrink-0 items-center rounded-full px-3 text-xs text-push-fg-secondary ${`${COMPOSER_CONTROL_SURFACE_CLASS} ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`}`}
              aria-label="Queue follow-up"
              title="Queue follow-up"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
              <span className="relative z-10">Queue</span>
            </button>
          )}

          {/* Send/Stop button */}
          <button
            type="button"
            onClick={handleButtonClick}
            disabled={!isStreaming && !canSend}
            className={`flex h-10 w-10 shrink-0 items-center justify-center ${
              isStreaming && !canStreamWithDraft
                ? `${COMPOSER_CONTROL_SURFACE_CLASS} border-red-400/50 [background-image:var(--push-surface-error-solid)] text-red-300 ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                : canSend || canStreamWithDraft
                  ? `${COMPOSER_CONTROL_SURFACE_CLASS} text-push-fg-secondary ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                  : 'cursor-not-allowed rounded-full border border-push-edge bg-push-surface-active text-push-fg-dimmest shadow-none'
            }`}
            aria-label={sendButtonLabel}
            title={sendButtonLabel}
          >
            {(isStreaming || canSend || canStreamWithDraft) && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
            )}
            {isStreaming && !canStreamWithDraft ? (
              <Square className="relative z-10 h-4 w-4 fill-current" />
            ) : (
              <SendLiftIcon className="relative z-10 h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
