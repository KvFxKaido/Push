import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MODEL_LOCKED_MESSAGE, type ComposerModelControl } from '@/lib/composer-provider-controls';
import { getVisionCapabilityNotice } from '@/lib/model-capabilities';
import { buildQuickPromptMessage } from '@/lib/quick-prompts';
import type { PreferredProvider } from '@/lib/providers';
import type {
  AIProviderType,
  AttachmentData,
  CardAction,
  ChatSendOptions,
  QuickPrompt,
} from '@/types';
import type { ChatRouteProps } from '@/sections/workspace-chat-route-types';
import { getProviderDisplayName } from '@push/lib/provider-definition';

type ComposerControllerArgs = Pick<
  ChatRouteProps,
  | 'messages'
  | 'sendMessage'
  | 'editMessageAndResend'
  | 'regenerateLastResponse'
  | 'handleCardAction'
  | 'catalog'
  | 'selectedChatProvider'
  | 'selectedChatModels'
  | 'handleSelectBackend'
  | 'handleSelectOllamaModelFromChat'
  | 'handleSelectOpenRouterModelFromChat'
  | 'handleSelectZaiModelFromChat'
  | 'handleSelectKimiModelFromChat'
  | 'handleSelectCloudflareModelFromChat'
  | 'handleSelectZenModelFromChat'
  | 'handleSelectNvidiaModelFromChat'
  | 'handleSelectFireworksModelFromChat'
  | 'handleSelectSakanaModelFromChat'
  | 'handleSelectDeepSeekModelFromChat'
  | 'handleSelectAnthropicModelFromChat'
  | 'handleSelectOpenAIModelFromChat'
  | 'handleSelectXAIModelFromChat'
  | 'handleSelectGoogleModelFromChat'
  | 'isProviderLocked'
  | 'lockedProvider'
  | 'lockedModel'
  | 'isModelLocked'
> & {
  markSnapshotActivity: () => void;
};

export function useWorkspaceChatComposerController({
  messages,
  sendMessage,
  editMessageAndResend,
  regenerateLastResponse,
  handleCardAction,
  catalog,
  selectedChatProvider,
  selectedChatModels,
  handleSelectBackend,
  handleSelectOllamaModelFromChat,
  handleSelectOpenRouterModelFromChat,
  handleSelectZaiModelFromChat,
  handleSelectKimiModelFromChat,
  handleSelectCloudflareModelFromChat,
  handleSelectZenModelFromChat,
  handleSelectNvidiaModelFromChat,
  handleSelectFireworksModelFromChat,
  handleSelectSakanaModelFromChat,
  handleSelectDeepSeekModelFromChat,
  handleSelectAnthropicModelFromChat,
  handleSelectOpenAIModelFromChat,
  handleSelectXAIModelFromChat,
  handleSelectGoogleModelFromChat,
  isProviderLocked,
  lockedProvider,
  lockedModel,
  isModelLocked,
  markSnapshotActivity,
}: ComposerControllerArgs) {
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null);
  const [composerPrefillRequest, setComposerPrefillRequest] = useState<{
    token: number;
    text: string;
    attachments?: AttachmentData[];
  } | null>(null);

  const selectedComposerProvider: AIProviderType = (() => {
    if (isProviderLocked && lockedProvider) return lockedProvider;
    if (selectedChatProvider) return selectedChatProvider;
    return catalog.availableProviders[0]?.[0] ?? 'demo';
  })();

  const isDisplayedComposerProviderLocked = Boolean(
    isProviderLocked && lockedProvider && lockedProvider === selectedComposerProvider,
  );

  const selectedComposerModel =
    isDisplayedComposerProviderLocked && lockedModel
      ? lockedModel
      : selectedComposerProvider === 'demo'
        ? 'demo'
        : selectedChatModels[selectedComposerProvider];

  const validateComposerAttachments = useCallback(
    (attachments?: AttachmentData[]) => {
      const hasImageAttachments = Boolean(
        attachments?.some((attachment) => attachment.type === 'image'),
      );
      if (!hasImageAttachments) return true;

      const visionNotice = getVisionCapabilityNotice(
        selectedComposerProvider,
        selectedComposerModel,
      );
      if (visionNotice.support !== 'unsupported') return true;

      const providerLabel = getProviderDisplayName(selectedComposerProvider);
      toast.error(`${providerLabel} · ${selectedComposerModel} cannot read image attachments yet.`);
      return false;
    },
    [selectedComposerModel, selectedComposerProvider],
  );

  const handleComposerSend = useCallback(
    (message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => {
      if (!validateComposerAttachments(attachments)) return;
      markSnapshotActivity();

      if (editingUserMessageId) {
        const targetMessageId = editingUserMessageId;
        setEditingUserMessageId(null);
        return editMessageAndResend(targetMessageId, message, attachments, options);
      }

      return sendMessage(message, attachments, options);
    },
    [
      editMessageAndResend,
      editingUserMessageId,
      markSnapshotActivity,
      sendMessage,
      validateComposerAttachments,
    ],
  );

  const handleQuickPrompt = useCallback(
    (quickPrompt: QuickPrompt) => {
      const { text, displayText } = buildQuickPromptMessage(quickPrompt);
      markSnapshotActivity();
      return sendMessage(text, undefined, { displayText });
    },
    [markSnapshotActivity, sendMessage],
  );

  const handleEditUserMessage = useCallback(
    (messageId: string) => {
      const target = messages.find(
        (message) => message.id === messageId && message.role === 'user' && !message.isToolResult,
      );
      if (!target) return;

      setEditingUserMessageId(messageId);
      setComposerPrefillRequest({
        token: Date.now(),
        text: target.displayContent ?? target.content,
        attachments: target.attachments,
      });
    },
    [messages],
  );

  const handleRegenerateLastResponse = useCallback(() => {
    setEditingUserMessageId(null);
    markSnapshotActivity();
    return regenerateLastResponse();
  }, [markSnapshotActivity, regenerateLastResponse]);

  useEffect(() => {
    if (!editingUserMessageId) return;
    const stillExists = messages.some(
      (message) =>
        message.id === editingUserMessageId && message.role === 'user' && !message.isToolResult,
    );
    if (!stillExists) {
      const timeout = setTimeout(() => setEditingUserMessageId(null), 0);
      return () => clearTimeout(timeout);
    }
  }, [editingUserMessageId, messages]);

  const handleCardActionWithSnapshotHeartbeat = useCallback(
    (action: CardAction) => {
      markSnapshotActivity();
      return handleCardAction(action);
    },
    [handleCardAction, markSnapshotActivity],
  );

  const isProviderModelLocked = (provider: PreferredProvider) =>
    isModelLocked && lockedProvider === provider;

  const buildPickerControl = (
    provider: PreferredProvider,
    options: Omit<Extract<ComposerModelControl, { kind: 'picker' }>, 'kind' | 'provider' | 'value'>,
  ): ComposerModelControl => ({
    kind: 'picker',
    provider,
    value: selectedChatModels[provider],
    lockedMessage: MODEL_LOCKED_MESSAGE,
    ...options,
  });

  const modelControls = {
    ollama: buildPickerControl('ollama', {
      options: catalog.ollamaModelOptions,
      onChange: handleSelectOllamaModelFromChat,
      loading: catalog.ollamaModels.loading,
      error: catalog.ollamaModels.error,
      updatedAt: catalog.ollamaModels.updatedAt,
      refreshModels: catalog.refreshOllamaModels,
      isLocked: isProviderModelLocked('ollama'),
      ariaLabel: 'Select Ollama model',
    }),
    openrouter: buildPickerControl('openrouter', {
      options: catalog.openRouterModelOptions,
      onChange: handleSelectOpenRouterModelFromChat,
      loading: catalog.openRouterModels.loading,
      error: catalog.openRouterModels.error,
      updatedAt: catalog.openRouterModels.updatedAt,
      refreshModels: catalog.refreshOpenRouterModels,
      isLocked: isProviderModelLocked('openrouter'),
      ariaLabel: 'Select OpenRouter model',
    }),
    zai: buildPickerControl('zai', {
      options: catalog.zaiModelOptions,
      onChange: handleSelectZaiModelFromChat,
      loading: catalog.zaiModels.loading,
      error: catalog.zaiModels.error,
      updatedAt: catalog.zaiModels.updatedAt,
      refreshModels: catalog.refreshZaiModels,
      isLocked: isProviderModelLocked('zai'),
      ariaLabel: 'Select Z.ai model',
    }),
    kimi: buildPickerControl('kimi', {
      options: catalog.kimiModelOptions,
      onChange: handleSelectKimiModelFromChat,
      loading: catalog.kimiModels.loading,
      error: catalog.kimiModels.error,
      updatedAt: catalog.kimiModels.updatedAt,
      refreshModels: catalog.refreshKimiModels,
      isLocked: isProviderModelLocked('kimi'),
      ariaLabel: 'Select Kimi model',
    }),
    cloudflare: buildPickerControl('cloudflare', {
      options: catalog.cloudflareModelOptions,
      onChange: handleSelectCloudflareModelFromChat,
      loading: catalog.cloudflareModels.loading,
      error: catalog.cloudflareModels.error,
      updatedAt: catalog.cloudflareModels.updatedAt,
      refreshModels: catalog.refreshCloudflareModels,
      isLocked: isProviderModelLocked('cloudflare'),
      ariaLabel: 'Select Cloudflare Workers AI model',
      footer: 'Uses the deployed Worker binding. No browser API key needed.',
    }),
    zen: buildPickerControl('zen', {
      options: catalog.zenModelOptions,
      onChange: handleSelectZenModelFromChat,
      loading: catalog.zenModels.loading,
      error: catalog.zenModels.error,
      updatedAt: catalog.zenModels.updatedAt,
      refreshModels: catalog.refreshZenModels,
      isLocked: isProviderModelLocked('zen'),
      ariaLabel: 'Select OpenCode Zen model',
    }),
    nvidia: buildPickerControl('nvidia', {
      options: catalog.nvidiaModelOptions,
      onChange: handleSelectNvidiaModelFromChat,
      loading: catalog.nvidiaModels.loading,
      error: catalog.nvidiaModels.error,
      updatedAt: catalog.nvidiaModels.updatedAt,
      refreshModels: catalog.refreshNvidiaModels,
      isLocked: isProviderModelLocked('nvidia'),
      ariaLabel: 'Select Nvidia NIM model',
    }),
    fireworks: buildPickerControl('fireworks', {
      options: catalog.fireworksModelOptions,
      onChange: handleSelectFireworksModelFromChat,
      loading: catalog.fireworksModels.loading,
      error: catalog.fireworksModels.error,
      updatedAt: catalog.fireworksModels.updatedAt,
      refreshModels: catalog.refreshFireworksModels,
      isLocked: isProviderModelLocked('fireworks'),
      ariaLabel: 'Select Fireworks AI model',
    }),
    sakana: buildPickerControl('sakana', {
      options: catalog.sakanaModelOptions,
      onChange: handleSelectSakanaModelFromChat,
      loading: catalog.sakanaModels.loading,
      error: catalog.sakanaModels.error,
      updatedAt: catalog.sakanaModels.updatedAt,
      refreshModels: catalog.refreshSakanaModels,
      isLocked: isProviderModelLocked('sakana'),
      ariaLabel: 'Select Sakana AI model',
    }),
    deepseek: buildPickerControl('deepseek', {
      options: catalog.deepseekModelOptions,
      onChange: handleSelectDeepSeekModelFromChat,
      loading: catalog.deepseekModels.loading,
      error: catalog.deepseekModels.error,
      updatedAt: catalog.deepseekModels.updatedAt,
      refreshModels: catalog.refreshDeepSeekModels,
      isLocked: isProviderModelLocked('deepseek'),
      ariaLabel: 'Select DeepSeek model',
    }),
    anthropic: buildPickerControl('anthropic', {
      options: catalog.anthropicModelOptions,
      onChange: handleSelectAnthropicModelFromChat,
      isLocked: isProviderModelLocked('anthropic'),
      ariaLabel: 'Select Anthropic model',
    }),
    openai: buildPickerControl('openai', {
      options: catalog.openaiModelOptions,
      onChange: handleSelectOpenAIModelFromChat,
      loading: catalog.openaiModels.loading,
      error: catalog.openaiModels.error,
      updatedAt: catalog.openaiModels.updatedAt,
      refreshModels: catalog.refreshOpenAIModels,
      isLocked: isProviderModelLocked('openai'),
      ariaLabel: 'Select OpenAI model',
    }),
    xai: buildPickerControl('xai', {
      options: catalog.xaiModelOptions,
      onChange: handleSelectXAIModelFromChat,
      loading: catalog.xaiModels.loading,
      error: catalog.xaiModels.error,
      updatedAt: catalog.xaiModels.updatedAt,
      refreshModels: catalog.refreshXAIModels,
      isLocked: isProviderModelLocked('xai'),
      ariaLabel: 'Select xAI model',
    }),
    google: buildPickerControl('google', {
      options: catalog.googleModelOptions,
      onChange: handleSelectGoogleModelFromChat,
      loading: catalog.googleModels.loading,
      error: catalog.googleModels.error,
      updatedAt: catalog.googleModels.updatedAt,
      refreshModels: catalog.refreshGoogleModels,
      isLocked: isProviderModelLocked('google'),
      ariaLabel: 'Select Google Gemini model',
    }),
  } satisfies Record<PreferredProvider, ComposerModelControl>;

  return {
    composerPrefillRequest,
    editState: editingUserMessageId
      ? {
          label: 'Editing an earlier message. Sending will replay the chat from here.',
          onCancel: () => setEditingUserMessageId(null),
        }
      : null,
    handleComposerSend,
    handleQuickPrompt,
    handleEditUserMessage,
    handleRegenerateLastResponse,
    handleCardActionWithSnapshotHeartbeat,
    providerControls: {
      selectedProvider: selectedChatProvider,
      availableProviders: catalog.availableProviders,
      isProviderLocked,
      lockedProvider,
      lockedModel,
      onSelectBackend: handleSelectBackend,
      modelControls,
    },
  };
}
