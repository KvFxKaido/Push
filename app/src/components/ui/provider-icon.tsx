import { useEffect, useState } from 'react';
import demoIcon from '@/assets/icons/push-pack-v1/push-orbit.svg';
import { cn } from '@/lib/utils';
import type { AIProviderType } from '@/types';

const MODELS_DEV_LOGOS: Record<AIProviderType, string> = {
  // `models.dev/logos/ollama.svg` currently resolves to a generic fallback.
  ollama: 'https://models.dev/logos/ollama-cloud.svg',
  mistral: 'https://models.dev/logos/mistral.svg',
  openrouter: 'https://models.dev/logos/openrouter.svg',
  minimax: 'https://models.dev/logos/minimax.svg',
  zai: 'https://models.dev/logos/zai.svg',
  google: 'https://models.dev/logos/google.svg',
  // `zen` is represented by OpenCode branding.
  zen: 'https://models.dev/logos/opencode.svg',
  nvidia: 'https://models.dev/logos/nvidia.svg',
  demo: demoIcon,
};

const PROVIDER_ALT: Record<AIProviderType, string> = {
  ollama: 'Ollama logo',
  mistral: 'Mistral logo',
  openrouter: 'OpenRouter logo',
  minimax: 'MiniMax logo',
  zai: 'Z.AI logo',
  google: 'Google logo',
  zen: 'OpenCode Zen logo',
  nvidia: 'NVIDIA NIM logo',
  demo: 'Push logo',
};

const PROVIDER_FALLBACK_TEXT: Record<AIProviderType, string> = {
  ollama: 'O',
  mistral: 'M',
  openrouter: 'OR',
  minimax: 'MM',
  zai: 'Z',
  google: 'G',
  zen: 'Z',
  nvidia: 'N',
  demo: 'P',
};

interface ProviderIconProps {
  provider: AIProviderType;
  size?: number;
  className?: string;
}

export function ProviderIcon({ provider, size = 14, className }: ProviderIconProps) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [provider]);

  const style = { width: size, height: size };

  if (hasError) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex items-center justify-center rounded-[4px] border border-push-edge bg-push-surface text-[8px] font-semibold leading-none text-push-fg-secondary',
          className,
        )}
        style={style}
      >
        {PROVIDER_FALLBACK_TEXT[provider]}
      </span>
    );
  }

  return (
    <img
      src={MODELS_DEV_LOGOS[provider]}
      alt={PROVIDER_ALT[provider]}
      className={cn('inline-block rounded-[4px] bg-white/90 object-contain p-px', className)}
      style={style}
      loading="lazy"
      onError={() => setHasError(true)}
    />
  );
}
