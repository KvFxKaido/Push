import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, ChevronsUpDown, Loader2, Lock, Paperclip, RefreshCw, Square } from 'lucide-react';
import { AttachmentPreview } from './AttachmentPreview';
import { ContextMeter } from './ContextMeter';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useIsMobile } from '@/hooks/use-mobile';
import { processFile, getTotalAttachmentSize } from '@/lib/file-processing';
import type { StagedAttachment } from '@/lib/file-processing';
import type { AIProviderType, AttachmentData } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import type { ExperimentalDeployment } from '@/lib/experimental-providers';

interface ChatInputProps {
  onSend: (message: string, attachments?: AttachmentData[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  repoName?: string;
  contextUsage?: { used: number; max: number; percent: number };
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

/** Show model name, adding an endpoint hint when multiple deployments share the same model. */
function formatDeploymentLabel(dep: ExperimentalDeployment, all: ExperimentalDeployment[]): string {
  const hasDuplicate = all.some(d => d.id !== dep.id && d.model === dep.model);
  if (!hasDuplicate) return dep.model;
  try {
    const host = new URL(dep.baseUrl).hostname.split('.')[0];
    return `${dep.model} (${host})`;
  } catch {
    return `${dep.model} (${dep.baseUrl.slice(0, 20)}…)`;
  }
}

const ACCEPTED_FILES = 'image/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.md,.txt,.json,.yaml,.yml,.html,.css,.sql,.sh,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.astro';
const MAX_PAYLOAD = 750 * 1024; // 750KB total

const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
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

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  repoName,
  contextUsage,
  providerControls,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const hasAttachments = stagedAttachments.length > 0;
  const readyAttachments = stagedAttachments.filter((a) => a.status === 'ready');
  const canSend = (value.trim().length > 0 || readyAttachments.length > 0) && !isStreaming;

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

  const handleSend = useCallback(() => {
    if (!canSend) return;

    // Convert staged attachments to AttachmentData (strip status/error fields)
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

    onSend(value.trim(), attachments.length > 0 ? attachments : undefined);
    setValue('');
    setStagedAttachments([]);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [canSend, value, readyAttachments, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Only use mobile keyboard behavior (Enter = newline) if BOTH:
      // 1. Narrow viewport (mobile layout) AND
      // 2. Touch capability (actual touch device)
      // This prevents desktop users with narrow windows from losing Enter-to-send
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isMobileDevice = isMobile && hasTouch;

      if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
        e.preventDefault();
        if (isStreaming) {
          onStop?.();
        } else {
          handleSend();
        }
      }
    },
    [handleSend, onStop, isStreaming, isMobile],
  );

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
  }, [stagedAttachments]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleButtonClick = () => {
    if (isStreaming) {
      onStop?.();
    } else {
      handleSend();
    }
  };

  const statusText = isStreaming
    ? 'Generating...'
    : readyAttachments.length > 0
      ? `${readyAttachments.length} attachment${readyAttachments.length > 1 ? 's' : ''} ready`
      : null;

  const selectedProvider: AIProviderType = (() => {
    if (!providerControls) return 'demo';
    if (providerControls.isProviderLocked && providerControls.lockedProvider) return providerControls.lockedProvider;
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
    if (isDisplayedProviderLocked && providerControls.lockedModel) return providerControls.lockedModel;
    if (selectedProvider === 'ollama') return providerControls.ollamaModel;
    if (selectedProvider === 'openrouter') return providerControls.openRouterModel;
    if (selectedProvider === 'zen') return providerControls.zenModel;
    if (selectedProvider === 'nvidia') return providerControls.nvidiaModel;
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
    if (selectedProvider === 'zen') return providerControls.zenModelsLoading;
    if (selectedProvider === 'nvidia') return providerControls.nvidiaModelsLoading;
    return false;
  })();

  const selectedModelUpdatedAgo = (() => {
    if (!providerControls) return null;
    if (selectedProvider === 'ollama') return formatTimeAgo(providerControls.ollamaModelsUpdatedAt);
    if (selectedProvider === 'zen') return formatTimeAgo(providerControls.zenModelsUpdatedAt);
    if (selectedProvider === 'nvidia') return formatTimeAgo(providerControls.nvidiaModelsUpdatedAt);
    return null;
  })();

  const canRefreshSelectedModelList = selectedProvider === 'ollama' || selectedProvider === 'zen' || selectedProvider === 'nvidia';
  const refreshSelectedModelList = () => {
    if (!providerControls) return;
    if (selectedProvider === 'ollama') providerControls.refreshOllamaModels();
    if (selectedProvider === 'zen') providerControls.refreshZenModels();
    if (selectedProvider === 'nvidia') providerControls.refreshNvidiaModels();
  };

  return (
    <div className="safe-area-bottom sticky bottom-0 z-10 px-3 pb-3 mx-auto w-full max-w-2xl">
      <div className="relative overflow-hidden rounded-[24px] border border-[#171c25]/90 bg-push-grad-input shadow-[0_12px_40px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white/[0.03] to-transparent" />

        {/* Attachment preview */}
        {hasAttachments && (
          <div className="px-3 pt-3">
            <AttachmentPreview
              attachments={stagedAttachments}
              onRemove={handleRemoveAttachment}
            />
          </div>
        )}

        {/* Text input */}
        <div className="px-3 pt-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={repoName ? `Ask about ${repoName}...` : 'Ask about code...'}
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none overflow-y-auto bg-transparent px-1 pb-2 text-push-lg leading-6 text-push-fg placeholder:text-[#6f7787] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex items-center gap-2 px-2 pb-2.5 pt-1.5">
          <div className="flex shrink-0 items-center gap-1.5">
            {/* File attachment button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all duration-200 spring-press ${
                isStreaming
                  ? 'cursor-not-allowed border-[#1f2430] text-[#545c6e]'
                  : 'border-push-edge bg-push-surface/95 text-[#8891a1] hover:border-push-edge-hover hover:bg-push-surface-hover hover:text-[#e2e8f0]'
              }`}
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </button>

            {providerControls && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 max-w-[170px] items-center gap-1.5 rounded-xl border border-push-edge bg-push-surface/95 px-2.5 text-push-xs text-[#a9b3c5] transition-colors hover:border-push-edge-hover hover:bg-push-surface-hover hover:text-[#e2e8f0]"
                    title={
                      isDisplayedProviderLocked
                        ? `${PROVIDER_LABELS[selectedProvider]} locked for this chat`
                        : 'Backend and model'
                    }
                  >
                    <ProviderIcon provider={selectedProvider} size={14} className="shrink-0" />
                    <span className="truncate">
                      {PROVIDER_LABELS[selectedProvider]} · {selectedModel}
                    </span>
                    {isDisplayedProviderLocked ? (
                      <Lock className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 shrink-0" />
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
                      <p className="px-1 text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">Backend</p>
                      {providerControls.availableProviders.length === 0 ? (
                        <div className="rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 py-2 text-push-xs text-[#7c879b]">
                          No API keys configured yet.
                        </div>
                      ) : (
                        <select
                          value={selectedBackendValue}
                          disabled={!canChangeProvider}
                          onChange={(e) => providerControls.onSelectBackend(e.target.value as PreferredProvider)}
                          className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                        >
                          {providerControls.availableProviders.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}{value === 'zen' ? ' (Recommended)' : ''}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-1">
                        <p className="text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">Model</p>
                        {canRefreshSelectedModelList && (
                          <button
                            type="button"
                            onClick={refreshSelectedModelList}
                            disabled={selectedModelLoading}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[#2a3447] bg-[#070a10] text-[#8e99ad] transition-colors hover:text-[#d7deeb] disabled:opacity-50"
                            aria-label="Refresh models"
                            title="Refresh models"
                          >
                            {selectedModelLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
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
                            disabled={!canChangeModel || providerControls.ollamaModelsLoading || providerControls.ollamaModelOptions.length === 0}
                            onChange={(e) => providerControls.onSelectOllamaModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.ollamaModelOptions.length > 0
                              ? providerControls.ollamaModelOptions
                              : [providerControls.ollamaModel]
                            ).map((model) => (
                              <option key={model || '__default'} value={model}>
                                {model || '(default)'}
                              </option>
                            ))}
                          </select>
                          {providerControls.ollamaModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Loading Ollama models...</p>
                          )}
                          {!providerControls.ollamaModelsLoading && providerControls.ollamaModelOptions.length === 0 && !providerControls.ollamaModelsError && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">No models returned. Try refresh.</p>
                          )}
                          {providerControls.ollamaModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">{providerControls.ollamaModelsError}</p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Updated {selectedModelUpdatedAgo}</p>
                          )}
                          {providerControls.isOllamaModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'openrouter' && (
                        <>
                          <select
                            value={providerControls.openRouterModel}
                            disabled={!canChangeModel || providerControls.openRouterModelOptions.length === 0}
                            onChange={(e) => providerControls.onSelectOpenRouterModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {providerControls.openRouterModelOptions.map((model) => (
                              <option key={model} value={model}>
                                {model.replace(/^[^/]+\//, '')}
                              </option>
                            ))}
                          </select>
                          {providerControls.isOpenRouterModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'zen' && (
                        <>
                          <select
                            value={providerControls.zenModel}
                            disabled={!canChangeModel || providerControls.zenModelsLoading || providerControls.zenModelOptions.length === 0}
                            onChange={(e) => providerControls.onSelectZenModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.zenModelOptions.length > 0
                              ? providerControls.zenModelOptions
                              : [providerControls.zenModel]
                            ).map((model) => (
                              <option key={model || '__default'} value={model}>
                                {model || '(default)'}
                              </option>
                            ))}
                          </select>
                          {providerControls.zenModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Loading OpenCode Zen models...</p>
                          )}
                          {!providerControls.zenModelsLoading && providerControls.zenModelOptions.length === 0 && !providerControls.zenModelsError && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">No models returned. Try refresh.</p>
                          )}
                          {providerControls.zenModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">{providerControls.zenModelsError}</p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Updated {selectedModelUpdatedAgo}</p>
                          )}
                          {providerControls.isZenModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'nvidia' && (
                        <>
                          <select
                            value={providerControls.nvidiaModel}
                            disabled={!canChangeModel || providerControls.nvidiaModelsLoading || providerControls.nvidiaModelOptions.length === 0}
                            onChange={(e) => providerControls.onSelectNvidiaModel(e.target.value)}
                            className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                          >
                            {(providerControls.nvidiaModelOptions.length > 0
                              ? providerControls.nvidiaModelOptions
                              : [providerControls.nvidiaModel]
                            ).map((model) => (
                              <option key={model || '__default'} value={model}>
                                {model || '(default)'}
                              </option>
                            ))}
                          </select>
                          {providerControls.nvidiaModelsLoading && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Loading Nvidia NIM models...</p>
                          )}
                          {!providerControls.nvidiaModelsLoading && providerControls.nvidiaModelOptions.length === 0 && !providerControls.nvidiaModelsError && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">No models returned. Try refresh.</p>
                          )}
                          {providerControls.nvidiaModelsError && (
                            <p className="px-1 text-push-2xs text-amber-400">{providerControls.nvidiaModelsError}</p>
                          )}
                          {selectedModelUpdatedAgo && (
                            <p className="px-1 text-push-2xs text-[#7c879b]">Updated {selectedModelUpdatedAgo}</p>
                          )}
                          {providerControls.isNvidiaModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'azure' && (
                        <>
                          {providerControls.azureDeployments.length > 0 ? (
                            <select
                              value={providerControls.azureActiveDeploymentId ?? ''}
                              disabled={!canChangeModel}
                              onChange={(e) => providerControls.onSelectAzureDeployment(e.target.value)}
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                            >
                              {providerControls.azureDeployments.map((dep) => (
                                <option key={dep.id} value={dep.id}>
                                  {formatDeploymentLabel(dep, providerControls.azureDeployments)}
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
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a deployment starts a new chat.</p>
                          )}
                        </>
                      )}

                      {selectedProvider === 'bedrock' && (
                        <>
                          {providerControls.bedrockDeployments.length > 0 ? (
                            <select
                              value={providerControls.bedrockActiveDeploymentId ?? ''}
                              disabled={!canChangeModel}
                              onChange={(e) => providerControls.onSelectBedrockDeployment(e.target.value)}
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60"
                            >
                              {providerControls.bedrockDeployments.map((dep) => (
                                <option key={dep.id} value={dep.id}>
                                  {formatDeploymentLabel(dep, providerControls.bedrockDeployments)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={providerControls.bedrockModel}
                              onChange={(e) => providerControls.onSelectBedrockModel(e.target.value)}
                              className="h-8 w-full rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579]"
                              placeholder="Bedrock model id"
                            />
                          )}
                          {providerControls.isBedrockModelLocked && (
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
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
                            <p className="px-1 text-push-2xs text-amber-400">Current chat locked; choosing a model starts a new chat.</p>
                          )}
                        </>
                      )}
                    </div>
                    <p className="px-1 text-push-2xs text-[#7c879b]">
                      Settings controls your defaults. This picker only changes the selected backend/model for this chat.
                    </p>
                    {isDisplayedProviderLocked && (
                      <p className="px-1 text-push-2xs text-amber-400">Changing backend/model here will start a new chat.</p>
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
            {statusText ? (
              <p className="truncate text-xs text-[#788396]">
                {statusText}
              </p>
            ) : contextUsage && contextUsage.percent >= 5 ? (
              <ContextMeter {...contextUsage} />
            ) : null}
          </div>

          {/* Send/Stop button */}
          <button
            type="button"
            onClick={handleButtonClick}
            disabled={!isStreaming && !canSend}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-all duration-200 spring-press ${
              isStreaming
                ? 'border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : canSend
                  ? 'border-push-sky/60 bg-push-sky/15 text-[#7dd3fc] shadow-[0_0_20px_rgba(56,189,248,0.2)] hover:bg-push-sky/25 hover:text-[#bae6fd] hover:shadow-[0_0_28px_rgba(56,189,248,0.3)]'
                  : 'cursor-not-allowed border-[#262c38] bg-[#151a22] text-[#576176]'
            }`}
            aria-label={isStreaming ? 'Stop generating' : 'Send message'}
            title={isStreaming ? 'Stop generating' : 'Send message'}
          >
            {isStreaming ? (
              <Square className="h-4 w-4 fill-current" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
