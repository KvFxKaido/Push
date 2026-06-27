import type { ReactNode } from 'react';
import type { ExperimentalDeployment } from '@/lib/experimental-providers';
import type { PreferredProvider } from '@/lib/providers';
import type { AIProviderType } from '@/types';

export const MODEL_LOCKED_MESSAGE = 'Current chat locked; choosing a model starts a new chat.';
export const DEPLOYMENT_LOCKED_MESSAGE =
  'Current chat locked; choosing a deployment starts a new chat.';

interface ComposerModelControlBase {
  provider: PreferredProvider;
  value: string;
  isLocked: boolean;
  lockedMessage?: string;
}

export interface ComposerPickerModelControl extends ComposerModelControlBase {
  kind: 'picker';
  options: string[];
  onChange: (model: string) => void;
  loading?: boolean;
  error?: string | null;
  updatedAt?: number | null;
  refreshModels?: () => void;
  ariaLabel: string;
  loadingLabel?: string;
  emptyLabel?: string;
  footer?: string;
  allowCustom?: boolean;
  customPlaceholder?: string;
  triggerLabel?: ReactNode;
  triggerTrailing?: ReactNode;
}

export interface ComposerDeploymentModelControl extends ComposerModelControlBase {
  kind: 'deployment';
  deployments: ExperimentalDeployment[];
  activeDeploymentId: string | null;
  onSelectDeployment: (id: string) => void;
  onChange: (model: string) => void;
  placeholder: string;
}

export type ComposerModelControl = ComposerPickerModelControl | ComposerDeploymentModelControl;

export interface ComposerProviderControls {
  selectedProvider: PreferredProvider | null;
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  isProviderLocked: boolean;
  lockedProvider: AIProviderType | null;
  lockedModel: string | null;
  onSelectBackend: (provider: PreferredProvider) => void;
  modelControls: Partial<Record<PreferredProvider, ComposerModelControl>>;
}
