import { useCallback, useMemo, useState } from 'react';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import { useSetting } from '@/hooks/useSetting';
import {
  normalizeFireworksModelName,
  normalizeSakanaModelName,
  type PreferredProvider,
} from '@/lib/providers';
import { safeStorageGet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS } from '@/lib/settings-store';
import type { AttachmentData, ChatSendOptions, Conversation } from '@/types';

// Pre-unification localStorage key, read once as a fallback.
const CHAT_MODEL_MEMORY_LEGACY_KEY = 'push:chat:last-used-models';

const EMPTY_CHAT_MODEL_MEMORY: Record<PreferredProvider, string> = {
  ollama: '',
  openrouter: '',
  cloudflare: '',
  zen: '',
  nvidia: '',
  anthropic: '',
  openai: '',
  google: '',
  fireworks: '',
  sakana: '',
  deepseek: '',
};

function coerceChatModelMemory(raw: unknown): Record<PreferredProvider, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const parsed = raw as Partial<Record<PreferredProvider, unknown>>;
  return {
    ollama: typeof parsed.ollama === 'string' ? parsed.ollama.trim() : '',
    openrouter: typeof parsed.openrouter === 'string' ? parsed.openrouter.trim() : '',
    cloudflare: typeof parsed.cloudflare === 'string' ? parsed.cloudflare.trim() : '',
    zen: typeof parsed.zen === 'string' ? parsed.zen.trim() : '',
    nvidia: typeof parsed.nvidia === 'string' ? parsed.nvidia.trim() : '',
    anthropic: typeof parsed.anthropic === 'string' ? parsed.anthropic.trim() : '',
    openai: typeof parsed.openai === 'string' ? parsed.openai.trim() : '',
    google: typeof parsed.google === 'string' ? parsed.google.trim() : '',
    fireworks:
      typeof parsed.fireworks === 'string' ? normalizeFireworksModelName(parsed.fireworks) : '',
    sakana: typeof parsed.sakana === 'string' ? normalizeSakanaModelName(parsed.sakana) : '',
    deepseek: typeof parsed.deepseek === 'string' ? parsed.deepseek.trim() : '',
  };
}

function legacyChatModelMemory(): Record<PreferredProvider, string> | undefined {
  const raw = safeStorageGet(CHAT_MODEL_MEMORY_LEGACY_KEY);
  if (!raw) return undefined;
  try {
    return coerceChatModelMemory(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** The current effective remembered-models record (store → legacy → empty). */
function currentChatModelMemory(): Record<PreferredProvider, string> {
  return (
    coerceChatModelMemory(getSetting(SETTINGS_KEYS.lastUsedModels)) ??
    legacyChatModelMemory() ?? { ...EMPTY_CHAT_MODEL_MEMORY }
  );
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
      fireworks: catalog.fireworks.model,
      sakana: catalog.sakana.model,
      anthropic: catalog.anthropic.model,
      openai: catalog.openai.model,
      google: catalog.google.model,
      deepseek: catalog.deepseek.model,
    }),
    [
      catalog.anthropic.model,
      catalog.openai.model,
      catalog.google.model,
      catalog.cloudflare.model,
      catalog.fireworks.model,
      catalog.sakana.model,
      catalog.nvidia.model,
      catalog.ollama.model,
      catalog.openRouter.model,
      catalog.zen.model,
      catalog.deepseek.model,
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

  const [rememberedChatModels, setRememberedChatModels] = useSetting<
    Record<PreferredProvider, string>
  >(SETTINGS_KEYS.lastUsedModels, EMPTY_CHAT_MODEL_MEMORY, {
    coerce: coerceChatModelMemory,
    legacyFallback: legacyChatModelMemory,
  });

  const rememberChatModel = useCallback(
    (provider: PreferredProvider, model: string | null | undefined) => {
      const trimmed =
        typeof model === 'string'
          ? provider === 'fireworks'
            ? normalizeFireworksModelName(model)
            : provider === 'sakana'
              ? normalizeSakanaModelName(model)
              : model.trim()
          : '';
      if (!trimmed) return;
      // Read fresh from the store rather than a possibly-stale closure value.
      const prev = currentChatModelMemory();
      if (prev[provider] === trimmed) return;
      setRememberedChatModels({ ...prev, [provider]: trimmed });
    },
    [setRememberedChatModels],
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
        anthropic:
          draft?.models?.anthropic?.trim() ||
          rememberedChatModels.anthropic ||
          defaultChatModels.anthropic,
        openai:
          draft?.models?.openai?.trim() || rememberedChatModels.openai || defaultChatModels.openai,
        google:
          draft?.models?.google?.trim() || rememberedChatModels.google || defaultChatModels.google,
        fireworks: normalizeFireworksModelName(
          draft?.models?.fireworks?.trim() ||
            rememberedChatModels.fireworks ||
            defaultChatModels.fireworks,
        ),
        sakana: normalizeSakanaModelName(
          draft?.models?.sakana?.trim() || rememberedChatModels.sakana || defaultChatModels.sakana,
        ),
        deepseek:
          draft?.models?.deepseek?.trim() ||
          rememberedChatModels.deepseek ||
          defaultChatModels.deepseek,
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
      activeConversation?.provider === 'fireworks' && activeConversation.model
        ? normalizeFireworksModelName(activeConversation.model)
        : activeConversation?.provider === 'sakana' && activeConversation.model
          ? normalizeSakanaModelName(activeConversation.model)
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

  const handleSelectFireworksModelFromChat = useCallback(
    (model: string) => {
      const normalizedModel = normalizeFireworksModelName(model);
      rememberChatModel('fireworks', normalizedModel);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { fireworks: normalizedModel } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectSakanaModelFromChat = useCallback(
    (model: string) => {
      const normalizedModel = normalizeSakanaModelName(model);
      rememberChatModel('sakana', normalizedModel);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { sakana: normalizedModel } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  const handleSelectDeepSeekModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('deepseek', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { deepseek: model } });
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

  const handleSelectGoogleModelFromChat = useCallback(
    (model: string) => {
      rememberChatModel('google', model);
      const chatId = ensureDraftChatForComposerChange();
      upsertChatDraft(chatId, { models: { google: model } });
    },
    [ensureDraftChatForComposerChange, rememberChatModel, upsertChatDraft],
  );

  return {
    selectedChatProvider: activeChatDraft.provider,
    selectedChatModels: activeChatDraft.models,
    sendMessageWithChatDraft,
    handleCreateNewChat,
    // Exposed so the pre-flight menu's drain effect can anchor a
    // newly minted chat to a user-picked provider/model without
    // touching the workspace-wide catalog default — the
    // first-send-anchors-lock mechanism then locks the chat to that
    // pick. Internal callers (handleSelectBackend / handleSelect*Model)
    // continue to wrap this with ensureDraftChatForComposerChange.
    upsertChatDraft,
    handleSelectBackend,
    handleSelectOllamaModelFromChat,
    handleSelectOpenRouterModelFromChat,
    handleSelectCloudflareModelFromChat,
    handleSelectZenModelFromChat,
    handleSelectNvidiaModelFromChat,
    handleSelectFireworksModelFromChat,
    handleSelectSakanaModelFromChat,
    handleSelectDeepSeekModelFromChat,
    handleSelectAnthropicModelFromChat,
    handleSelectOpenAIModelFromChat,
    handleSelectGoogleModelFromChat,
  };
}
