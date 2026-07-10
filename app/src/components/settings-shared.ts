import type { ComponentType, SVGProps } from 'react';
import { AICoreIcon, WorkspaceTuneIcon, YouBadgeIcon } from '@/components/icons/push-custom-icons';
import { formatModelDisplayName, type PreferredProvider } from '@/lib/providers';
import type { AIProviderType } from '@/types';
import {
  REAL_PROVIDERS,
  getBuiltInSettingsProviderDefinitions,
  getProviderDisplayName,
} from '@push/lib/provider-definition';

export const PROVIDER_LABELS: Record<AIProviderType, string> = Object.fromEntries([
  ...REAL_PROVIDERS.map((providerId) => [providerId, getProviderDisplayName(providerId)]),
  ['demo', 'Demo'],
]) as Record<AIProviderType, string>;

export type BuiltInSettingsProviderId = Extract<
  PreferredProvider,
  | 'ollama'
  | 'openrouter'
  | 'zai'
  | 'kimi'
  | 'zen'
  | 'nvidia'
  | 'fireworks'
  | 'sakana'
  | 'deepseek'
  | 'anthropic'
  | 'openai'
  | 'xai'
  | 'google'
>;

export type SettingsSectionIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const SETTINGS_SECTION_ICONS: Record<'you' | 'workspace' | 'ai', SettingsSectionIcon> = {
  you: YouBadgeIcon,
  workspace: WorkspaceTuneIcon,
  ai: AICoreIcon,
};

const BUILT_IN_SETTINGS_PROVIDER_DEFINITIONS = getBuiltInSettingsProviderDefinitions();

export const BUILT_IN_SETTINGS_PROVIDER_ORDER: BuiltInSettingsProviderId[] =
  BUILT_IN_SETTINGS_PROVIDER_DEFINITIONS.map((def) => def.id as BuiltInSettingsProviderId);

export const BUILT_IN_SETTINGS_PROVIDER_META: Record<
  BuiltInSettingsProviderId,
  {
    placeholder: string;
    saveLabel: string;
    hint: string;
    byokPartialNote?: string;
    labelTransform?: (model: string) => string;
  }
> = Object.fromEntries(
  BUILT_IN_SETTINGS_PROVIDER_DEFINITIONS.map((def) => {
    const { keyPlaceholder, keySaveLabel, keyHint, byokPartialNote } = def.settings;
    if (!keyPlaceholder || !keySaveLabel || !keyHint) {
      throw new Error(`Provider "${def.id}" is missing built-in settings key copy`);
    }
    return [
      def.id,
      {
        placeholder: keyPlaceholder,
        saveLabel: keySaveLabel,
        hint: keyHint,
        ...(byokPartialNote ? { byokPartialNote } : {}),
        labelTransform: (model: string) => formatModelDisplayName(def.id, model),
      },
    ];
  }),
) as Record<
  BuiltInSettingsProviderId,
  {
    placeholder: string;
    saveLabel: string;
    hint: string;
    byokPartialNote?: string;
    labelTransform?: (model: string) => string;
  }
>;

export const TAVILY_SETTINGS_META = {
  placeholder: 'tvly-...',
  saveLabel: 'Save Tavily key',
  hint: 'Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month.',
} as const;
