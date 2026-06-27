import type { ComponentType, SVGProps } from 'react';
import { AICoreIcon, WorkspaceTuneIcon, YouBadgeIcon } from '@/components/icons/push-custom-icons';
import { formatModelDisplayName, type PreferredProvider } from '@/lib/providers';
import type { ExperimentalProviderType } from '@/lib/experimental-providers';
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
  | 'zen'
  | 'nvidia'
  | 'kilocode'
  | 'fireworks'
  | 'sakana'
  | 'deepseek'
  | 'anthropic'
  | 'openai'
  | 'google'
>;

export type ExperimentalSettingsProviderId = Extract<ExperimentalProviderType, 'azure' | 'bedrock'>;

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
    labelTransform?: (model: string) => string;
  }
> = Object.fromEntries(
  BUILT_IN_SETTINGS_PROVIDER_DEFINITIONS.map((def) => {
    const { keyPlaceholder, keySaveLabel, keyHint } = def.settings;
    if (!keyPlaceholder || !keySaveLabel || !keyHint) {
      throw new Error(`Provider "${def.id}" is missing built-in settings key copy`);
    }
    return [
      def.id,
      {
        placeholder: keyPlaceholder,
        saveLabel: keySaveLabel,
        hint: keyHint,
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
    labelTransform?: (model: string) => string;
  }
>;

export const EXPERIMENTAL_SETTINGS_PROVIDER_ORDER: ExperimentalSettingsProviderId[] = [
  'azure',
  'bedrock',
];

export const EXPERIMENTAL_SETTINGS_PROVIDER_META: Record<
  ExperimentalSettingsProviderId,
  {
    helperText: string;
    baseUrlPlaceholder: string;
    modelPlaceholder: string;
  }
> = {
  azure: {
    helperText:
      'Use either your classic Azure OpenAI /openai/v1 base URL or an Azure AI Foundry project URL. Push normalizes Foundry project URLs to .../openai/v1.',
    baseUrlPlaceholder: 'https://your-resource.services.ai.azure.com/api/projects/PROJECT',
    modelPlaceholder: 'Deployment or model name',
  },
  bedrock: {
    helperText:
      'Use the Bedrock OpenAI-compatible /openai/v1 base URL for a specific region and the exact model id.',
    baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    modelPlaceholder: 'Bedrock model id',
  },
};

export const TAVILY_SETTINGS_META = {
  placeholder: 'tvly-...',
  saveLabel: 'Save Tavily key',
  hint: 'Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month.',
} as const;
