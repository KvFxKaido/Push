import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import { normalizeKilocodeModelName, type PreferredProvider } from '@/lib/providers';
import { safeStorageGet, safeStorageSet } from '@/lib/safe-storage';
import type { AttachmentData, ChatSendOptions, Conversation } from '@/types';

const CHAT_MODEL_MEMORY_STORAGE_KEY = 'push:chat:last-used-models';

const EMPTY_CHAT_MODEL_MEMORY: Record<PreferredProvider, string> = {
  ollama: '',
  openrouter: '',
  cloudflare: '',
  zen: '',
  nvidia: '',
  blackbox: '',
  azure: '',
  bedrock: '',
  vertex: '',
  anthropic: '',
  openai: '',
  kilocode: '',
  openadapter: '',
};

function readStoredChatModelMemory(): Record<PreferredProvider, string> {
  const raw = safeStorageGet(CHAT_MODEL_MEMORY_STORAGE_KEY);
  if (!raw) return { ...EMPTY_CHAT_MODEL_MEMORY };

  try {
    const parsed = JSON.parse(raw) as Partial<Record<PreferredProvider, unknown>>;
    return {
      ollama: typeof parsed.ollama === 'string' ? parsed.ollama.trim() : '',
      openrouter: typeof parsed.openrouter === 'string' ? parsed.openrouter.trim() : '',
      cloudflare: typeof parsed.cloudflare === 'string' ? parsed.cloudflare.trim() : '',
      zen: typeof parsed.zen === 'string' ? parsed.zen.trim() : '',
      nvidia: typeof parsed.nvidia === 'string' ? parsed.nvidia.trim() : '',
      blackbox: typeof parsed.blackbox === 'string' ? parsed.blackbox.trim() : '',
      azure: typeof parsed.azure === 'string' ? parsed.azure.trim() : '',
      bedrock: typeof parsed.bedrock === 'string' ? parsed.bedrock.trim() : '',
      vertex: typeof parsed.vertex === 'string' ? parsed.vertex.trim() : '',
      anthropic: typeof parsed.anthropic === 'string' ? parsed.anthropic.trim() : '',
      openai: typeof parsed.openai === 'string' ? parsed.openai.trim() : '',
      kilocode:
        typeof parsed.kilocode === 'string' ? normalizeKilocodeModelName(parsed.kilocode) : '',
      openadapter: typeof parsed.openadapter === 'string' ? parsed.openadapter.trim() : '',
    };
  } catch {
    return { ...EMPTY_CHAT_MODEL_MEMORY };
  }
}

type ChatComposerDraft = {
  provider: PreferredProvider | null;
  models: Record<PreferredProvider, string>;
};

type ChatComposerDraftUpdate = {
  provider?: PreferredProvider | null;
  models?: Partial<Record<PreferredProvider, string>>;
};

type WorkspaceComposerStateArgs = {
  catalog: ModelCatalog;
  conversations: Record<string, Conversation>;
  activeChatId: string | null;
  isProviderLocked: boolean;
  isModelLocked: boolean;
  createNewChat: () => string;
  switchChat: (id: string) => void;
  sendMessage: (
    message: string,
    attachments?: AttachmentData[],
    options?: ChatSendOptions & {
      provider?: Conversation['provider'] | null;
      model?: string | null;
    },
  ) => Promise<void> | void;
};

export function useWorkspaceComposerState({
  catalog,
  conversations,
  activeChatId,
  isProviderLocked,
  isModelLocked,
  createNewChat,
  switchChat,
  sendMessage,
}: WorkspaceComposerStateArgs) {
  const defaultChatModels = useMemo<Record<PreferredProvider, string>>(
    () => ({
      ollama: catalog.ollama.model,
      openrouter: catalog.openRouter.model,
      cloudflare: catalog.cloudflare.model,
      zen: catalog.zen.model,
      nvidia: catalog.nvidia.model,
      blackbox: catalog.blackbox.model,
      kilocode: catalog.kilocode.model,
      openadapter: catalog.openadapter.model,
      azure: catalog.azure.model,
      bedrock: catalog.bedrock.model,
      vertex: catalog.vertex.model,
      anthropic: catalog.anthropic.model,
      openai: catalog.openai.model,
    }),
    [
      catalog.anthropic.model,
      catalog.openai.model,
      catalog.azure.model,
      catalog.bedrock.model,
      catalog.blackbox.model,
      catalog.cloudflare.model,
      catalog.kilocode.model,
      catalog.nvidia.model,
      catalog.ollama.model,
      catalog.openadapter.model,
      catalog.openRouter.model,
      catalog.vertex.model,
      catalog.zen.model,
    ],
  );

  const availableChatProviders = useMemo(
    () => new Set(catalog.availableProviders.map(([provider]) => provider)),
    [catalog.availableProviders],
  );

  const defaultChatProvider = useMemo<PreferredProvider | null>(() => {
    if (catalog.activeBackend && availableChatProviders.has(catalog.activeBackend)) {
      return catalog.activeBackend;
    }
    if (
      catalog.activeProviderLabel !== 'demo' &&
      availableChatProviders.has(catalog.activeProviderLabel)
    ) {
      return catalog.activeProviderLabel;
    }
    return catalog.availableProviders[0]?.[0] ?? null;
  }, [
    availableChatProviders,
    catalog.activeBackend,
    catalog.activeProviderLabel,
    catalog.availableProviders,
  ]);

  const [rememberedChatModels, setRememberedChatModels] = useState<
    Record<PreferredProvider, string>
  >(() => readStoredChatModelMemory());

  useEffect(() => {
    safeStorageSet(CHAT_MODEL_MEMORY_STORAGE_KEY, JSON.stringify(rememberedChatModels));
  }, [rememberedChatModels]);

  const rememberChatModel = useCallback(
    (provider: PreferredProvider, model: string | null | undefined) => {
      const trimmed =
        typeof model === 'string'
          ? provider === 'kilocode'
            ? normalizeKilocodeModelName(model)
            : model.trim()
          : '';
      if (!trimmed) return;
      setRememberedChatModels((prev) =>
        prev[provider] === trimmed ? prev : { ...prev, [provider]: trimmed },
      );
    },
    [],
  );

  const normalizeChatDraft = useCallback(
    (draft?: Partial<ChatComposerDraft> | null): ChatComposerDraft => {
      const models: Record<PreferredProvider, string> = {
        ollama:
          draft?.models?.ollama?.trim() || rememberedChatModels.ollama || defaultChatModels.ollama,
        openrouter:
          draft?.models?.openrouter?.trim() ||
          rememberedChatModels.openrouter ||
          defaultChatModels.openrouter,
        cloudflare:
          draft?.models?.cloudflare?.trim() ||
          rememberedChatModels.cloudflare ||
          defaultChatModels.cloudflare,
        zen: draft?.models?.zen?.trim() || rememberedChatModels.zen || defaultChatModels.zen,
        nvidia:
          draft?.models?.nvidia?.trim() || rememberedChatModels.nvidia || defaultChatModels.nvidia,
        blackbox:
          draft?.models?.blackbox?.trim() ||
          rememberedChatModels.blackbox ||
          defaultChatModels.blackbox,
        azure:
          draft?.models?.azure?.trim() || rememberedChatModels.azure || defaultChatModels.azure,
        bedrock:
          draft?.models?.bedrock?.trim() ||
          rememberedChatModels.bedrock ||
          defaultChatModels.bedrock,
        vertex:
          draft?.models?.vertex?.trim() || rememberedChatModels.vertex || defaultChatModels.vertex,
        anthropic:
          draft?.models?.anthropic?.trim() ||
          rememberedChatModels.anthropic ||
          defaultChatModels.anthropic,
        openai:
          draft?.models?.openai?.trim() || rememberedChatModels.openai || defaultChatModels.openai,
        kilocode: normalizeKilocodeModelName(
          draft?.models?.kilocode?.trim() ||
            rememberedChatModels.kilocode ||
            defaultChatModels.kilocode,
        ),
        openadapter:
          draft?.models?.openadapter?.trim() ||
          rememberedChatModels.openadapter ||
          defaultChatModels.openadapter,
      };

      let provider = draft?.provider ?? defaultChatProvider;
      if (provider && !availableChatProviders.has(provider)) {
        provider = defaultChatProvider;
      }

      return { provider, models };
    },
    [availableChatProviders, defaultChatModels, defaultChatProvider, rememberedChatModels],
  );

  const [storedChatDrafts, setStoredChatDrafts] = useState<Record<string, ChatComposerDraft>>({});

  const chatDrafts = useMemo(() => {
    const next: Record<string, ChatComposerDraft> = {};

    for (const [chatId, draft] of Object.entries(storedChatDrafts)) {
      const conversation = conversations[chatId];
      if (!conversation || conversation.provider) continue;
      next[chatId] = draft;
    }

    return next;
  }, [conversations, storedChatDrafts]);

  const activeConversation = activeChatId ? conversations[activeChatId] : undefined;

  const activeChatDraft = (() => {
    const storedDraft = activeChatId ? chatDrafts[activeChatId] : null;
    const baseDraft = normalizeChatDraft(storedDraft);
    const lockedConversationModel =
      activeConversation?.provider === 'kilocode' && activeConversation.model
        ? normalizeKilocodeModelName(activeConversation.model)
        : activeConversation?.model;

    if (activeConversation?.provider && activeConversation.provider !== 'demo') {
      return normalizeChatDraft({
        provider: activeConversation.provider,
        models: lockedConversationModel
          ? { ...baseDraft.models, [activeConversation.provider]: lockedConversationModel }
          : baseDraft.models,
      });
    }

    return baseDraft;
  })();

  const upsertChatDraft = useCallback(
    (chatId: string, updates: ChatComposerDraftUpdate) => {
      setStoredChatDrafts((prev) => {
        const current = normalizeChatDraft(prev[chatId]);
        const next = normalizeChatDraft({
          provider: updates.provider ?? current.provider,
          models: {
            ...current.models,
            ...(updates.models ?? {}),
          },
        });
        return {
          ...prev,
          [chatId]: next,
        };
      });
    },
    [normalizeChatDraft],
  );

  const ensureDraftChatForComposerChange = useCallback((): string => {
    if (activeChatId && !isProviderLocked && !isModelLocked) {
      return activeChatId;
    }

    const nextId = createNewChat();
    upsertChatDraft(nextId, activeChatDraft);
    return nextId;
  }, [
    activeChatDraft,
    activeChatId,
    createNewChat,
    isModelLocked,
    isProviderLocked,
    upsertChatDraft,
  ]);

  const sendMessageWithChatDraft = useCallback(
    (message: string, attachments?: AttachmentData[], options?: ChatSendOptions) => {
      if (activeChatDraft.provider) {
        rememberChatModel(
          activeChatDraft.provider,
          activeChatDraft.models[activeChatDraft.provider],
        );
      }
      return sendMessage(message, attachments, {
        ...options,
        provider: activeChatDraft.provider,
        model: activeChatDraft.provider ? activeChatDraft.models[activeChatDraft.provider] : null,
      });
    },
    [activeChatDraft, rememberChatModel, sendMessage],
  );

  const handleCreateNewChat = useCallback(() => {
    if (activeChatDraft.provider) {
      rememberChatModel(activeChatDraft.provider, activeChatDraft.models[activeChatDraft.provider]);
    }
    const id = createNewChat();
    switchChat(id);
  }, [activeChatDraft, createNewChat, rememberChatModel, switchChat]);

  const handleSelectBackend = useCallback(
    (provider: PreferredProvider) => {
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { provider });
    },
    [ensureDraftChatForComposerChange, upsertChatDraft],
  );

  const handleSelectOllamaModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('ollama', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { ollama: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectOpenRouterModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('openrouter', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { openrouter: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectCloudflareModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('cloudflare', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { cloudflare: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectZenModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('zen', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { zen: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectNvidiaModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('nvidia', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { nvidia: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectBlackboxModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('blackbox', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { blackbox: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectKilocodeModelFromChat = useCallback(
    (model: string) => {
      const normalizedModel = normalizeKilocodeModelName(model);
      rememberChatModel('kilocode', normalizedModel);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { kilocode: normalizedModel } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectOpenAdapterModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('openadapter', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { openadapter: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectAzureModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('azure', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { azure: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectBedrockModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('bedrock', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { bedrock: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectVertexModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('vertex', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { vertex: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectAnthropicModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('anthropic', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { anthropic: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectOpenAIModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('openai', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { openai: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  return {
    selectedChatProvider: activeChatDraft.provider,
    selectedChatModels: activeChatDraft.models,
    sendMessageWithChatDraft,
    handleCreateNewChat,
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
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
  };
}
