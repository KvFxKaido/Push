import type { ReactNode } from 'react';
import type { PreferredProvider } from '@/lib/providers';
import type { AIProviderType } from '@/types';

export const MODEL_LOCKED_MESSAGE = 'Current chat locked; choosing a model starts a new chat.';

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

export type ComposerModelControl = ComposerPickerModelControl;

export interface ComposerProviderControls {
  selectedProvider: PreferredProvider | null;
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  isProviderLocked: boolean;
  lockedProvider: AIProviderType | null;
  lockedModel: string | null;
  onSelectBackend: (provider: PreferredProvider) => void;
  modelControls: Partial<Record<PreferredProvider, ComposerModelControl>>;
}
