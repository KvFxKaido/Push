import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getVisionCapabilityNotice } from '@/lib/model-capabilities';
import { buildQuickPromptMessage } from '@/lib/quick-prompts';
import type {
  AIProviderType,
  AttachmentData,
  CardAction,
  ChatSendOptions,
  QuickPrompt,
} from '@/types';
import type { ChatRouteProps } from '@/sections/workspace-chat-route-types';

const CHAT_PROVIDER_LABELS: Record<AIProviderType, string> = {
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
  anthropic: 'Anthropic',
  demo: 'Demo',
};

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
  | 'handleSelectCloudflareModelFromChat'
  | 'handleSelectZenModelFromChat'
  | 'handleSelectNvidiaModelFromChat'
  | 'handleSelectBlackboxModelFromChat'
  | 'handleSelectKilocodeModelFromChat'
  | 'handleSelectOpenAdapterModelFromChat'
  | 'handleSelectAzureModelFromChat'
  | 'handleSelectBedrockModelFromChat'
  | 'handleSelectVertexModelFromChat'
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
  handleSelectCloudflareModelFromChat,
  handleSelectZenModelFromChat,
  handleSelectNvidiaModelFromChat,
  handleSelectBlackboxModelFromChat,
  handleSelectKilocodeModelFromChat,
  handleSelectOpenAdapterModelFromChat,
  handleSelectAzureModelFromChat,
  handleSelectBedrockModelFromChat,
  handleSelectVertexModelFromChat,
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

  const selectedComposerModel = (() => {
    if (isDisplayedComposerProviderLocked && lockedModel) return lockedModel;
    if (selectedComposerProvider === 'ollama') return selectedChatModels.ollama;
    if (selectedComposerProvider === 'openrouter') return selectedChatModels.openrouter;
    if (selectedComposerProvider === 'cloudflare') return selectedChatModels.cloudflare;
    if (selectedComposerProvider === 'zen') return selectedChatModels.zen;
    if (selectedComposerProvider === 'nvidia') return selectedChatModels.nvidia;
    if (selectedComposerProvider === 'blackbox') return selectedChatModels.blackbox;
    if (selectedComposerProvider === 'kilocode') return selectedChatModels.kilocode;
    if (selectedComposerProvider === 'openadapter') return selectedChatModels.openadapter;
    if (selectedComposerProvider === 'azure') return selectedChatModels.azure;
    if (selectedComposerProvider === 'bedrock') return selectedChatModels.bedrock;
    if (selectedComposerProvider === 'vertex') return selectedChatModels.vertex;
    return 'demo';
  })();

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

      const providerLabel = CHAT_PROVIDER_LABELS[selectedComposerProvider];
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

  const handleSelectAzureDeploymentFromChat = useCallback(
    (id: string) => {
      const deployment = catalog.azure.deployments.find((candidate) => candidate.id === id);
      if (!deployment) return;
      catalog.azure.selectDeployment(id);
      handleSelectAzureModelFromChat(deployment.model);
    },
    [catalog.azure, handleSelectAzureModelFromChat],
  );

  const handleSelectBedrockDeploymentFromChat = useCallback(
    (id: string) => {
      const deployment = catalog.bedrock.deployments.find((candidate) => candidate.id === id);
      if (!deployment) return;
      catalog.bedrock.selectDeployment(id);
      handleSelectBedrockModelFromChat(deployment.model);
    },
    [catalog.bedrock, handleSelectBedrockModelFromChat],
  );

  const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
  const isCloudflareModelLocked = isModelLocked && lockedProvider === 'cloudflare';
  const isZenModelLocked = isModelLocked && lockedProvider === 'zen';
  const isNvidiaModelLocked = isModelLocked && lockedProvider === 'nvidia';
  const isBlackboxModelLocked = isModelLocked && lockedProvider === 'blackbox';
  const isKilocodeModelLocked = isModelLocked && lockedProvider === 'kilocode';
  const isOpenAdapterModelLocked = isModelLocked && lockedProvider === 'openadapter';
  const isAzureModelLocked = isModelLocked && lockedProvider === 'azure';
  const isBedrockModelLocked = isModelLocked && lockedProvider === 'bedrock';
  const isVertexModelLocked = isModelLocked && lockedProvider === 'vertex';

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
      ollamaModel: selectedChatModels.ollama,
      ollamaModelOptions: catalog.ollamaModelOptions,
      ollamaModelsLoading: catalog.ollamaModels.loading,
      ollamaModelsError: catalog.ollamaModels.error,
      ollamaModelsUpdatedAt: catalog.ollamaModels.updatedAt,
      isOllamaModelLocked,
      refreshOllamaModels: catalog.refreshOllamaModels,
      onSelectOllamaModel: handleSelectOllamaModelFromChat,
      openRouterModel: selectedChatModels.openrouter,
      openRouterModelOptions: catalog.openRouterModelOptions,
      isOpenRouterModelLocked: isProviderLocked && lockedProvider === 'openrouter',
      onSelectOpenRouterModel: handleSelectOpenRouterModelFromChat,
      cloudflareModel: selectedChatModels.cloudflare,
      cloudflareModelOptions: catalog.cloudflareModelOptions,
      cloudflareModelsLoading: catalog.cloudflareModels.loading,
      cloudflareModelsError: catalog.cloudflareModels.error,
      cloudflareModelsUpdatedAt: catalog.cloudflareModels.updatedAt,
      isCloudflareModelLocked,
      refreshCloudflareModels: catalog.refreshCloudflareModels,
      onSelectCloudflareModel: handleSelectCloudflareModelFromChat,
      zenModel: selectedChatModels.zen,
      zenModelOptions: catalog.zenModelOptions,
      zenModelsLoading: catalog.zenModels.loading,
      zenModelsError: catalog.zenModels.error,
      zenModelsUpdatedAt: catalog.zenModels.updatedAt,
      isZenModelLocked,
      refreshZenModels: catalog.refreshZenModels,
      onSelectZenModel: handleSelectZenModelFromChat,
      nvidiaModel: selectedChatModels.nvidia,
      nvidiaModelOptions: catalog.nvidiaModelOptions,
      nvidiaModelsLoading: catalog.nvidiaModels.loading,
      nvidiaModelsError: catalog.nvidiaModels.error,
      nvidiaModelsUpdatedAt: catalog.nvidiaModels.updatedAt,
      isNvidiaModelLocked,
      refreshNvidiaModels: catalog.refreshNvidiaModels,
      onSelectNvidiaModel: handleSelectNvidiaModelFromChat,
      blackboxModel: selectedChatModels.blackbox,
      blackboxModelOptions: catalog.blackboxModelOptions,
      blackboxModelsLoading: catalog.blackboxModels.loading,
      blackboxModelsError: catalog.blackboxModels.error,
      blackboxModelsUpdatedAt: catalog.blackboxModels.updatedAt,
      isBlackboxModelLocked,
      refreshBlackboxModels: catalog.refreshBlackboxModels,
      onSelectBlackboxModel: handleSelectBlackboxModelFromChat,
      kilocodeModel: selectedChatModels.kilocode,
      kilocodeModelOptions: catalog.kilocodeModelOptions,
      kilocodeModelsLoading: catalog.kilocodeModels.loading,
      kilocodeModelsError: catalog.kilocodeModels.error,
      kilocodeModelsUpdatedAt: catalog.kilocodeModels.updatedAt,
      isKilocodeModelLocked,
      refreshKilocodeModels: catalog.refreshKilocodeModels,
      onSelectKilocodeModel: handleSelectKilocodeModelFromChat,
      openadapterModel: selectedChatModels.openadapter,
      openadapterModelOptions: catalog.openAdapterModelOptions,
      openadapterModelsLoading: catalog.openAdapterModels.loading,
      openadapterModelsError: catalog.openAdapterModels.error,
      openadapterModelsUpdatedAt: catalog.openAdapterModels.updatedAt,
      isOpenAdapterModelLocked,
      refreshOpenAdapterModels: catalog.refreshOpenAdapterModels,
      onSelectOpenAdapterModel: handleSelectOpenAdapterModelFromChat,
      azureModel: selectedChatModels.azure,
      azureDeployments: catalog.azure.deployments,
      azureActiveDeploymentId: catalog.azure.activeDeploymentId,
      isAzureModelLocked,
      onSelectAzureModel: handleSelectAzureModelFromChat,
      onSelectAzureDeployment: handleSelectAzureDeploymentFromChat,
      bedrockModel: selectedChatModels.bedrock,
      bedrockDeployments: catalog.bedrock.deployments,
      bedrockActiveDeploymentId: catalog.bedrock.activeDeploymentId,
      isBedrockModelLocked,
      onSelectBedrockModel: handleSelectBedrockModelFromChat,
      onSelectBedrockDeployment: handleSelectBedrockDeploymentFromChat,
      vertexModel: selectedChatModels.vertex,
      vertexModelOptions: catalog.vertex.modelOptions,
      isVertexModelLocked,
      onSelectVertexModel: handleSelectVertexModelFromChat,
    },
  };
}
