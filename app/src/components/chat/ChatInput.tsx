import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ChevronsUpDown, Loader2, Lock, RefreshCw, Square } from 'lucide-react';
import { AttachmentPreview } from './AttachmentPreview';
import { ContextMeter } from './ContextMeter';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelPicker } from '@/components/ui/model-picker';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useIsMobile } from '@/hooks/use-mobile';
import { processFile, getTotalAttachmentSize } from '@/lib/file-processing';
import type { StagedAttachment } from '@/lib/file-processing';
import { getVisionCapabilityNotice } from '@/lib/model-capabilities';
import {
  getModelCapabilities,
  formatModelCapabilityHints,
  getReasoningEffort,
  cycleReasoningEffort,
  REASONING_EFFORT_LABELS,
  type ReasoningEffort,
} from '@/lib/model-catalog';
import type { AIProviderType, AttachmentData, ChatSendOptions } from '@/types';
import {
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayGroupLabel,
  getModelDisplayLeafName,
} from '@/lib/providers';

/** Group model IDs by provider prefix and render as optgroups with capability hints. */
function renderGroupedModelOptions(models: string[], provider: AIProviderType) {
  const groups = new Map<string, { label: string | null; models: string[] }>();

  for (const model of models) {
    const groupKey = getModelDisplayGroupKey(provider, model);
    const mapKey = groupKey || '__ungrouped__';
    const existing = groups.get(mapKey);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    groups.set(mapKey, {
      label: groupKey ? getModelDisplayGroupLabel(groupKey) : null,
      models: [model],
    });
  }

  return Array.from(groups.entries()).flatMap(([groupKey, group]) => {
    const options = group.models.map((model) => {
      const displayName = group.label
        ? getModelDisplayLeafName(provider, model)
        : formatModelDisplayName(provider, model);
      const hints = formatModelCapabilityHints(getModelCapabilities(provider, model));
      return (
        <option key={model} value={model}>
          {hints ? `${displayName}  ·  ${hints}` : displayName}
        </option>
      );
    });

    if (!group.label) return options;

    return (
      <optgroup key={groupKey} label={group.label}>
        {options}
      </optgroup>
    );
  });
}
import type { PreferredProvider } from '@/lib/providers';
import type { ExperimentalDeployment } from '@/lib/experimental-providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import {
  AttachmentLinkIcon,
  SendLiftIcon,
  VoicePulseIcon,
} from '@/components/icons/push-custom-icons';

interface ChatInputProps {
  onSend: (message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  queuedFollowUpCount?: number;
  pendingSteerCount?: number;
  repoName?: string;
  placeholder?: string;
  contextUsage?: { used: number; max: number; percent: number };
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
  providerControls?: {
    selectedProvider: PreferredProvider | null;
    availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
    isProviderLocked: boolean;
    lockedProvider: AIProviderType | null;
    lockedModel: string | null;
    onSelectBackend: (provider: PreferredProvider) => void;
    ollamaModel: string;
    ollamaModelOptions: string[];
    ollamaModelsLoading: boolean;
    ollamaModelsError: string | null;
    ollamaModelsUpdatedAt: number | null;
    isOllamaModelLocked: boolean;
    refreshOllamaModels: () => void;
    onSelectOllamaModel: (model: string) => void;
    openRouterModel: string;
    openRouterModelOptions: string[];
    isOpenRouterModelLocked: boolean;
    onSelectOpenRouterModel: (model: string) => void;
    cloudflareModel: string;
    cloudflareModelOptions: string[];
    cloudflareModelsLoading: boolean;
    cloudflareModelsError: string | null;
    cloudflareModelsUpdatedAt: number | null;
    isCloudflareModelLocked: boolean;
    refreshCloudflareModels: () => void;
    onSelectCloudflareModel: (model: string) => void;
    zenModel: string;
    zenModelOptions: string[];
    zenModelsLoading: boolean;
    zenModelsError: string | null;
    zenModelsUpdatedAt: number | null;
    isZenModelLocked: boolean;
    refreshZenModels: () => void;
    onSelectZenModel: (model: string) => void;
    nvidiaModel: string;
    nvidiaModelOptions: string[];
    nvidiaModelsLoading: boolean;
    nvidiaModelsError: string | null;
    nvidiaModelsUpdatedAt: number | null;
    isNvidiaModelLocked: boolean;
    refreshNvidiaModels: () => void;
    onSelectNvidiaModel: (model: string) => void;
    blackboxModel: string;
    blackboxModelOptions: string[];
    blackboxModelsLoading: boolean;
    blackboxModelsError: string | null;
    blackboxModelsUpdatedAt: number | null;
    isBlackboxModelLocked: boolean;
    refreshBlackboxModels: () => void;
    onSelectBlackboxModel: (model: string) => void;
    kilocodeModel: string;
    kilocodeModelOptions: string[];
    kilocodeModelsLoading: boolean;
    kilocodeModelsError: string | null;
    kilocodeModelsUpdatedAt: number | null;
    isKilocodeModelLocked: boolean;
    refreshKilocodeModels: () => void;
    onSelectKilocodeModel: (model: string) => void;
    openadapterModel: string;
    openadapterModelOptions: string[];
    openadapterModelsLoading: boolean;
    openadapterModelsError: string | null;
    openadapterModelsUpdatedAt: number | null;
    isOpenAdapterModelLocked: boolean;
    refreshOpenAdapterModels: () => void;
    onSelectOpenAdapterModel: (model: string) => void;
    azureModel: string;
    azureDeployments: ExperimentalDeployment[];
    azureActiveDeploymentId: string | null;
    isAzureModelLocked: boolean;
    onSelectAzureModel: (model: string) => void;
    onSelectAzureDeployment: (id: string) => void;
    bedrockModel: string;
    bedrockDeployments: ExperimentalDeployment[];
    bedrockActiveDeploymentId: string | null;
    isBedrockModelLocked: boolean;
    onSelectBedrockModel: (model: string) => void;
    onSelectBedrockDeployment: (id: string) => void;
    vertexModel: string;
    vertexModelOptions: string[];
    isVertexModelLocked: boolean;
    onSelectVertexModel: (model: string) => void;
  };
}

function formatDeploymentLabel(dep: ExperimentalDeployment): string {
  return dep.model;
}

const ACCEPTED_FILES =
  'image/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.md,.txt,.json,.yaml,.yml,.html,.css,.sql,.sh,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.astro';
const MAX_PAYLOAD = 750 * 1024; // 750KB total
const COMPOSER_DRAFT_KEY_PREFIX = 'push:chat-composer-draft:';

const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  blackbox: 'Blackbox AI',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  kilocode: 'Kilo Code',
  openadapter: 'OpenAdapter',
  vertex: 'Google Vertex',
  demo: 'Demo',
};

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
const EMPTY_MODEL_OPTIONS: string[] = [];

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
  queuedFollowUpCount = 0,
  pendingSteerCount = 0,
  repoName,
  placeholder,
  contextUsage,
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
    recognition.onerror = () => setIsListening(false);
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
  const canSendBase = hasDraftContent && !isStreaming;

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

  const selectedModel = (() => {
    if (!providerControls) return '';
    if (isDisplayedProviderLocked && providerControls.lockedModel)
      return providerControls.lockedModel;
    if (selectedProvider === 'ollama') return providerControls.ollamaModel;
    if (selectedProvider === 'openrouter') return providerControls.openRouterModel;
    if (selectedProvider === 'cloudflare') return providerControls.cloudflareModel;
    if (selectedProvider === 'zen') return providerControls.zenModel;
    if (selectedProvider === 'nvidia') return providerControls.nvidiaModel;
    if (selectedProvider === 'blackbox') return providerControls.blackboxModel;
    if (selectedProvider === 'kilocode') return providerControls.kilocodeModel;
    if (selectedProvider === 'openadapter') return providerControls.openadapterModel;
    if (selectedProvider === 'azure') return providerControls.azureModel;
    if (selectedProvider === 'bedrock') return providerControls.bedrockModel;
    if (selectedProvider === 'vertex') return providerControls.vertexModel;
    return 'demo';
  })();

  const canChangeProvider = Boolean(providerControls);
  const canChangeModel = Boolean(providerControls);
  const backendValues = providerControls?.availableProviders.map(([value]) => value) ?? [];
  const selectedBackendValue = backendValues.includes(selectedProvider as PreferredProvider)
    ? (selectedProvider as PreferredProvider)
    : (backendValues[0] ?? '');

  const selectedModelLoading = (() => {
    if (!providerControls) return false;
    if (selectedProvider === 'ollama') return providerControls.ollamaModelsLoading;
    if (selectedProvider === 'cloudflare') return providerControls.cloudflareModelsLoading;
    if (selectedProvider === 'zen') return providerControls.zenModelsLoading;
    if (selectedProvider === 'nvidia') return providerControls.nvidiaModelsLoading;
    if (selectedProvider === 'blackbox') return providerControls.blackboxModelsLoading;
    if (selectedProvider === 'kilocode') return providerControls.kilocodeModelsLoading;
    if (selectedProvider === 'openadapter') return providerControls.openadapterModelsLoading;
    return false;
  })();

  const selectedModelUpdatedAgo = (() => {
    if (!providerControls) return null;
    if (selectedProvider === 'ollama') return formatTimeAgo(providerControls.ollamaModelsUpdatedAt);
    if (selectedProvider === 'cloudflare')
      return formatTimeAgo(providerControls.cloudflareModelsUpdatedAt);
    if (selectedProvider === 'zen') return formatTimeAgo(providerControls.zenModelsUpdatedAt);
    if (selectedProvider === 'nvidia') return formatTimeAgo(providerControls.nvidiaModelsUpdatedAt);
    if (selectedProvider === 'blackbox')
      return formatTimeAgo(providerControls.blackboxModelsUpdatedAt);
    if (selectedProvider === 'kilocode')
      return formatTimeAgo(providerControls.kilocodeModelsUpdatedAt);
    if (selectedProvider === 'openadapter')
      return formatTimeAgo(providerControls.openadapterModelsUpdatedAt);
    return null;
  })();

  const canRefreshSelectedModelList =
    selectedProvider === 'ollama' ||
    selectedProvider === 'cloudflare' ||
    selectedProvider === 'zen' ||
    selectedProvider === 'nvidia' ||
    selectedProvider === 'blackbox' ||
    selectedProvider === 'kilocode' ||
    selectedProvider === 'openadapter';
  const refreshSelectedModelList = () => {
    if (!providerControls) return;
    if (selectedProvider === 'ollama') providerControls.refreshOllamaModels();
    if (selectedProvider === 'cloudflare') providerControls.refreshCloudflareModels();
    if (selectedProvider === 'zen') providerControls.refreshZenModels();
    if (selectedProvider === 'nvidia') providerControls.refreshNvidiaModels();
    if (selectedProvider === 'blackbox') providerControls.refreshBlackboxModels();
    if (selectedProvider === 'kilocode') providerControls.refreshKilocodeModels();
    if (selectedProvider === 'openadapter') providerControls.refreshOpenAdapterModels();
  };
  const cloudflareModelList = providerControls?.cloudflareModelOptions ?? EMPTY_MODEL_OPTIONS;
  const blackboxModelList = providerControls?.blackboxModelOptions ?? EMPTY_MODEL_OPTIONS;
  const blackboxFallbackModel = providerControls?.blackboxModel ?? '';
  const kilocodeModelList = providerControls?.kilocodeModelOptions ?? EMPTY_MODEL_OPTIONS;

  const kilocodeFallbackModel = providerControls?.kilocodeModel ?? '';
  const openAdapterModelList = providerControls?.openadapterModelOptions ?? EMPTY_MODEL_OPTIONS;
  const openAdapterFallbackModel = providerControls?.openadapterModel ?? '';

  const cloudflareModelOptions = useMemo(
    () => renderGroupedModelOptions(cloudflareModelList, 'cloudflare'),
    [cloudflareModelList],
  );

  const blackboxModelOptions = useMemo(() => {
    const models =
      blackboxModelList.length > 0
        ? blackboxModelList
        : blackboxFallbackModel
          ? [blackboxFallbackModel]
          : [];
    return renderGroupedModelOptions(models, 'blackbox');
  }, [blackboxFallbackModel, blackboxModelList]);

  const kilocodeModelOptions = useMemo(() => {
    const models =
      kilocodeModelList.length > 0
        ? kilocodeModelList
        : kilocodeFallbackModel
          ? [kilocodeFallbackModel]
          : [];
    return renderGroupedModelOptions(models, 'kilocode');
  }, [kilocodeFallbackModel, kilocodeModelList]);

  const openAdapterModelOptions = useMemo(() => {
    const models =
      openAdapterModelList.length > 0
        ? openAdapterModelList
        : openAdapterFallbackModel
          ? [openAdapterFallbackModel]
          : [];
    return renderGroupedModelOptions(models, 'openadapter');
  }, [openAdapterFallbackModel, openAdapterModelList]);

  // Reasoning effort (per-provider, only for models that support it)
  const modelCaps = getModelCapabilities(selectedProvider, selectedModel);
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() =>
    getReasoningEffort(selectedProvider),
  );

  // Sync reasoning effort when provider changes
  useEffect(() => {
    setReasoningEffortState(getReasoningEffort(selectedProvider));
  }, [selectedProvider]);

  const handleCycleReasoning = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Don't open the popover
      const next = cycleReasoningEffort(selectedProvider);
      setReasoningEffortState(next);
    },
    [selectedProvider],
  );

  // Display model name: strip provider prefix for OpenRouter, use as-is for others
  const displayModelName = selectedModel.replace(/^[^/]+\//, '');

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
    Boolean(isStreaming) && hasDraftContent && !hasUnsupportedImageAttachments;

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
      <div className="relative overflow-hidden rounded-[24px] border border-[#171c25]/90 bg-push-grad-input shadow-[0_12px_40px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white/[0.03] to-transparent" />

        {editState && (
          <div className="px-3 pt-3">
            <div className="flex items-center justify-between gap-3 rounded-[18px] border border-amber-500/20 bg-[linear-gradient(180deg,rgba(62,45,16,0.16)_0%,rgba(22,17,7,0.3)_100%)] px-3.5 py-2.5">
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
            className="w-full resize-none overflow-y-auto bg-transparent px-1 pb-2 text-push-lg leading-6 text-push-fg placeholder:text-[#6f7787] focus:outline-none"
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

            {providerControls && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`flex h-10 max-w-[188px] items-center gap-2 px-3 text-push-xs text-push-fg-secondary ${COMPOSER_CONTROL_SURFACE_CLASS} ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`}
                    title={
                      isDisplayedProviderLocked
                        ? `${PROVIDER_LABELS[selectedProvider]} locked for this chat`
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
                  className="w-[250px] rounded-xl border border-[#1f2531] bg-push-grad-panel p-2.5 text-[#d7deeb] shadow-[0_12px_36px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] animate-fade-in"
                >
                  <div className="space-y-2.5 px-1 py-1">
                    <div className="rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-1.5">
                      <p className="text-push-2xs text-[#8e99ad]">
                        {isDisplayedProviderLocked ? 'Current chat: locked' : 'This chat selection'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="px-1 text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">
                        Backend
                      </p>
                      {providerControls.availableProviders.length === 0 ? (
                        <div className="rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-2 text-push-xs text-[#7c879b]">
                          No API keys configured yet.
                        </div>
                      ) : (
                        <select
                          value={selectedBackendValue}
                          disabled={!canChangeProvider}
                          onChange={(e) =>
                            providerControls.onSelectBackend(e.target.value as PreferredProvider)
                          }
                          className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
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
                        <p className="text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">
                          Model
                        </p>
                        {canRefreshSelectedModelList && (
                          <button
                            type="button"
                            onClick={refreshSelectedModelList}
                            disabled={selectedModelLoading}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[#2a3447] bg-[#070a10] text-[#8e99ad] transition-colors hover:text-[#d7deeb] disabled:opacity-50"
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

                      {selectedProvider === 'demo' && (
                        <div className="rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-2 text-push-xs text-[#9eabbe]">
                          Demo mode (no model selection)
                        </div>
                      )}

                      {selectedProvider === 'ollama' && (
                        <>
                          <select
                            value={providerControls.ollamaModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.ollamaModelsLoading ||
                              providerControls.ollamaModelOptions.length === 0
                            }
                            onChange={(e) => providerControls.onSelectOllamaModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.ollamaModelOptions.length > 0
                              ? providerControls.ollamaModelOptions
                              : [providerControls.ollamaModel]
                            ).map((model) => {
                              const hints = model
                                ? formatModelCapabilityHints(getModelCapabilities('ollama', model))
                                : '';
                              return (
                                <option key={model || '__default'} value={model}>
                                  {model
                                    ? hints
                                      ? `${formatModelDisplayName('ollama', model)}  ·  ${hints}`
                                      : formatModelDisplayName('ollama', model)
                                    : '(default)'}
                                </option>
                              );
                            })}
                          </select>
                          {providerControls.ollamaModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading Ollama models...
                            </p>
                          )}
                          {!providerControls.ollamaModelsLoading &&
                            providerControls.ollamaModelOptions.length === 0 &&
                            !providerControls.ollamaModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.ollamaModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.ollamaModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isOllamaModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'openrouter' && (
                        <>
                          <ModelPicker
                            provider="openrouter"
                            value={providerControls.openRouterModel}
                            options={providerControls.openRouterModelOptions}
                            onChange={providerControls.onSelectOpenRouterModel}
                            disabled={!canChangeModel}
                            ariaLabel="Select OpenRouter model"
                            triggerLabel={
                              <>
                                {displayModelName}
                                {modelCaps.reasoning && (
                                  <span className="text-push-2xs text-[#7c879b]">
                                    {REASONING_EFFORT_LABELS[reasoningEffort]}
                                  </span>
                                )}
                              </>
                            }
                          />
                          {providerControls.isOpenRouterModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'cloudflare' && (
                        <>
                          <select
                            value={providerControls.cloudflareModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.cloudflareModelsLoading ||
                              providerControls.cloudflareModelOptions.length === 0
                            }
                            onChange={(e) =>
                              providerControls.onSelectCloudflareModel(e.target.value)
                            }
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {cloudflareModelOptions}
                          </select>
                          {providerControls.cloudflareModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading Cloudflare Workers AI models...
                            </p>
                          )}
                          {!providerControls.cloudflareModelsLoading &&
                            providerControls.cloudflareModelOptions.length === 0 &&
                            !providerControls.cloudflareModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.cloudflareModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.cloudflareModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          <p className="px-1 text-push-2xs text-[#7c879b]">
                            Uses the deployed Worker binding. No browser API key needed.
                          </p>
                          {providerControls.isCloudflareModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'zen' && (
                        <>
                          <select
                            value={providerControls.zenModel}
                            disabled={
                              !canChangeModel || providerControls.zenModelOptions.length === 0
                            }
                            onChange={(e) => providerControls.onSelectZenModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.zenModelOptions.length > 0
                              ? providerControls.zenModelOptions
                              : [providerControls.zenModel]
                            ).map((model) => {
                              const hints = model
                                ? formatModelCapabilityHints(getModelCapabilities('zen', model))
                                : '';
                              return (
                                <option key={model || '__default'} value={model}>
                                  {model
                                    ? hints
                                      ? `${formatModelDisplayName('zen', model)}  ·  ${hints}`
                                      : formatModelDisplayName('zen', model)
                                    : '(default)'}
                                </option>
                              );
                            })}
                          </select>
                          {providerControls.zenModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading OpenCode Zen models...
                            </p>
                          )}
                          {!providerControls.zenModelsLoading &&
                            providerControls.zenModelOptions.length === 0 &&
                            !providerControls.zenModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.zenModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.zenModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isZenModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'nvidia' && (
                        <>
                          <select
                            value={providerControls.nvidiaModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.nvidiaModelsLoading ||
                              providerControls.nvidiaModelOptions.length === 0
                            }
                            onChange={(e) => providerControls.onSelectNvidiaModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.nvidiaModelOptions.length > 0
                              ? providerControls.nvidiaModelOptions
                              : [providerControls.nvidiaModel]
                            ).map((model) => {
                              const hints = model
                                ? formatModelCapabilityHints(getModelCapabilities('nvidia', model))
                                : '';
                              return (
                                <option key={model || '__default'} value={model}>
                                  {model
                                    ? hints
                                      ? `${formatModelDisplayName('nvidia', model)}  ·  ${hints}`
                                      : formatModelDisplayName('nvidia', model)
                                    : '(default)'}
                                </option>
                              );
                            })}
                          </select>
                          {providerControls.nvidiaModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading Nvidia NIM models...
                            </p>
                          )}
                          {!providerControls.nvidiaModelsLoading &&
                            providerControls.nvidiaModelOptions.length === 0 &&
                            !providerControls.nvidiaModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.nvidiaModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.nvidiaModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isNvidiaModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'blackbox' && (
                        <>
                          <select
                            value={providerControls.blackboxModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.blackboxModelsLoading ||
                              providerControls.blackboxModelOptions.length === 0
                            }
                            onChange={(e) => providerControls.onSelectBlackboxModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {blackboxModelOptions}
                          </select>
                          {providerControls.blackboxModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading Blackbox AI models...
                            </p>
                          )}
                          {!providerControls.blackboxModelsLoading &&
                            providerControls.blackboxModelOptions.length === 0 &&
                            !providerControls.blackboxModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.blackboxModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.blackboxModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isBlackboxModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'kilocode' && (
                        <>
                          <select
                            value={providerControls.kilocodeModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.kilocodeModelsLoading ||
                              providerControls.kilocodeModelOptions.length === 0
                            }
                            onChange={(e) => providerControls.onSelectKilocodeModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {kilocodeModelOptions}
                          </select>
                          {providerControls.kilocodeModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading Kilo Code models...
                            </p>
                          )}
                          {!providerControls.kilocodeModelsLoading &&
                            providerControls.kilocodeModelOptions.length === 0 &&
                            !providerControls.kilocodeModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.kilocodeModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.kilocodeModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isKilocodeModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'openadapter' && (
                        <>
                          <select
                            value={providerControls.openadapterModel}
                            disabled={
                              !canChangeModel ||
                              providerControls.openadapterModelsLoading ||
                              providerControls.openadapterModelOptions.length === 0
                            }
                            onChange={(e) =>
                              providerControls.onSelectOpenAdapterModel(e.target.value)
                            }
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {openAdapterModelOptions}
                          </select>
                          {providerControls.openadapterModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Loading OpenAdapter models...
                            </p>
                          )}
                          {!providerControls.openadapterModelsLoading &&
                            providerControls.openadapterModelOptions.length === 0 &&
                            !providerControls.openadapterModelsError && (
                              <p className="px-1 text-push-2xs text-[#7c879b]">
                                No models returned. Try refresh.
                              </p>
                            )}
                          {providerControls.openadapterModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              {providerControls.openadapterModelsError}
                            </p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">
                              Updated {selectedModelUpdatedAgo}
                            </p>
                          )}
                          {providerControls.isOpenAdapterModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'azure' && (
                        <>
                          {providerControls.azureDeployments.length > 0 ? (
                            <select
                              value={providerControls.azureActiveDeploymentId ?? ''}
                              disabled={!canChangeModel}
                              onChange={(e) =>
                                providerControls.onSelectAzureDeployment(e.target.value)
                              }
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                            >
                              {providerControls.azureDeployments.map((dep) => (
                                <option key={dep.id} value={dep.id}>
                                  {formatDeploymentLabel(dep)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={providerControls.azureModel}
                              onChange={(e) => providerControls.onSelectAzureModel(e.target.value)}
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579]"
                              placeholder="Deployment or model"
                            />
                          )}
                          {providerControls.isAzureModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a deployment starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'bedrock' && (
                        <>
                          {providerControls.bedrockDeployments.length > 0 ? (
                            <select
                              value={providerControls.bedrockActiveDeploymentId ?? ''}
                              disabled={!canChangeModel}
                              onChange={(e) =>
                                providerControls.onSelectBedrockDeployment(e.target.value)
                              }
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                            >
                              {providerControls.bedrockDeployments.map((dep) => (
                                <option key={dep.id} value={dep.id}>
                                  {formatDeploymentLabel(dep)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={providerControls.bedrockModel}
                              onChange={(e) =>
                                providerControls.onSelectBedrockModel(e.target.value)
                              }
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579]"
                              placeholder="Bedrock model id"
                            />
                          )}
                          {providerControls.isBedrockModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'vertex' && (
                        <>
                          <select
                            value={providerControls.vertexModel}
                            disabled={!canChangeModel}
                            onChange={(e) => providerControls.onSelectVertexModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.vertexModelOptions.length > 0
                              ? providerControls.vertexModelOptions
                              : [providerControls.vertexModel]
                            ).map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                          {providerControls.isVertexModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">
                              Current chat locked; choosing a model starts a new chat.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <p className="px-1 text-push-2xs text-[#7c879b]">
                      Settings controls your defaults. This picker only changes the selected
                      backend/model for this chat.
                    </p>
                    <p
                      className={`px-1 text-push-2xs ${
                        visionNotice.support === 'supported'
                          ? 'text-emerald-400'
                          : visionNotice.support === 'unsupported'
                            ? 'text-amber-400'
                            : 'text-[#7c879b]'
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
            accept={ACCEPTED_FILES}
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
                      : 'text-[#788396]'
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
                ? `${COMPOSER_CONTROL_SURFACE_CLASS} border-red-400/50 bg-[linear-gradient(180deg,rgba(55,12,18,0.96)_0%,rgba(28,7,11,0.98)_100%)] text-red-300 ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                : canSend || canStreamWithDraft
                  ? `${COMPOSER_CONTROL_SURFACE_CLASS} text-push-fg-secondary ${COMPOSER_CONTROL_INTERACTIVE_CLASS}`
                  : 'cursor-not-allowed rounded-full border border-[#262c38] bg-[#151a22] text-[#576176] shadow-none'
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
