import type { ComponentType, SVGProps } from 'react';
import { AICoreIcon, WorkspaceTuneIcon, YouBadgeIcon } from '@/components/icons/push-custom-icons';
import type { PreferredProvider } from '@/lib/providers';
import type { ExperimentalProviderType } from '@/lib/experimental-providers';
import type { AIProviderType } from '@/types';

export const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex',
  demo: 'Demo',
};

export type BuiltInSettingsProviderId = Extract<
  PreferredProvider,
  'ollama' | 'openrouter' | 'zen' | 'nvidia'
>;

export type ExperimentalSettingsProviderId = Extract<
  ExperimentalProviderType,
  'azure' | 'bedrock'
>;

export type SettingsSectionIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const SETTINGS_SECTION_ICONS: Record<'you' | 'workspace' | 'ai', SettingsSectionIcon> = {
  you: YouBadgeIcon,
  workspace: WorkspaceTuneIcon,
  ai: AICoreIcon,
};

export const BUILT_IN_SETTINGS_PROVIDER_ORDER: BuiltInSettingsProviderId[] = [
  'ollama',
  'openrouter',
  'nvidia',
  'zen',
];

export const BUILT_IN_SETTINGS_PROVIDER_META: Record<
  BuiltInSettingsProviderId,
  {
    placeholder: string;
    saveLabel: string;
    hint: string;
    labelTransform?: (model: string) => string;
  }
> = {
  ollama: {
    placeholder: 'Ollama API key',
    saveLabel: 'Save Ollama key',
    hint: 'Ollama API key (local or cloud).',
  },
  openrouter: {
    placeholder: 'OpenRouter API key',
    saveLabel: 'Save OpenRouter key',
    hint: 'OpenRouter API key from openrouter.ai. BYOK works too: keep provider-native keys in your OpenRouter account, then use your OpenRouter key here.',
    labelTransform: (model) => model.replace(/^[^/]+\//, ''),
  },
  nvidia: {
    placeholder: 'Nvidia API key',
    saveLabel: 'Save Nvidia key',
    hint: 'Nvidia NIM API key (OpenAI-compatible endpoint).',
  },
  zen: {
    placeholder: 'Zen API key',
    saveLabel: 'Save OpenCode Zen key',
    hint: 'OpenCode Zen API key for https://opencode.ai/zen.',
  },
};

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
    helperText: 'Use either your classic Azure OpenAI /openai/v1 base URL or an Azure AI Foundry project URL. Push normalizes Foundry project URLs to .../openai/v1.',
    baseUrlPlaceholder: 'https://your-resource.services.ai.azure.com/api/projects/PROJECT',
    modelPlaceholder: 'Deployment or model name',
  },
  bedrock: {
    helperText: 'Use the Bedrock OpenAI-compatible /openai/v1 base URL for a specific region and the exact model id.',
    baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    modelPlaceholder: 'Bedrock model id',
  },
};

export const TAVILY_SETTINGS_META = {
  placeholder: 'tvly-...',
  saveLabel: 'Save Tavily key',
  hint: 'Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month.',
} as const;
