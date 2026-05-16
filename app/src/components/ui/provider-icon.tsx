import { useState } from 'react';
import demoIcon from '@/assets/icons/push-pack-v1/push-orbit.svg';
import { cn } from '@/lib/utils';
import type { AIProviderType } from '@/types';

const MODELS_DEV_LOGOS: Record<AIProviderType, string> = {
  // `models.dev/logos/ollama.svg` currently resolves to a generic fallback.
  ollama: 'https://models.dev/logos/ollama-cloud.svg',
  openrouter: 'https://models.dev/logos/openrouter.svg',
  cloudflare: 'https://models.dev/logos/cloudflare.svg',
  // `zen` is represented by OpenCode branding.
  zen: 'https://models.dev/logos/opencode.svg',
  nvidia: 'https://models.dev/logos/nvidia.svg',
  blackbox: 'https://www.blackbox.ai/favicon.ico',
  azure: 'https://models.dev/logos/azure.svg',
  bedrock: 'https://models.dev/logos/aws.svg',
  vertex: 'https://models.dev/logos/google.svg',
  anthropic: 'https://models.dev/logos/anthropic.svg',
  openai: 'https://models.dev/logos/openai.svg',
  kilocode: 'https://kilo.ai/favicon.ico',
  openadapter: 'https://openadapter.dev/favicon.ico',
  demo: demoIcon,
};

const PROVIDER_ALT: Record<AIProviderType, string> = {
  ollama: 'Ollama logo',
  openrouter: 'OpenRouter logo',
  cloudflare: 'Cloudflare logo',
  zen: 'OpenCode Zen logo',
  nvidia: 'NVIDIA NIM logo',
  blackbox: 'Blackbox AI logo',
  azure: 'Azure OpenAI logo',
  bedrock: 'AWS Bedrock logo',
  vertex: 'Google Vertex logo',
  anthropic: 'Anthropic logo',
  openai: 'OpenAI logo',
  kilocode: 'Kilo Code logo',
  openadapter: 'OpenAdapter logo',
  demo: 'Push logo',
};

const PROVIDER_FALLBACK_TEXT: Record<AIProviderType, string> = {
  ollama: 'O',
  openrouter: 'OR',
  cloudflare: 'CF',
  zen: 'Z',
  nvidia: 'N',
  blackbox: 'BB',
  azure: 'Az',
  bedrock: 'B',
  vertex: 'V',
  anthropic: 'A',
  openai: 'OA',
  kilocode: 'K',
  openadapter: 'OA',
  demo: 'P',
};

interface ProviderIconProps {
  provider: AIProviderType;
  size?: number;
  className?: string;
}

export function ProviderIcon({ provider, size = 14, className }: ProviderIconProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = MODELS_DEV_LOGOS[provider];
  const hasError = failedSrc === src;

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
      src={src}
      alt={PROVIDER_ALT[provider]}
      className={cn('inline-block rounded-[4px] bg-white/90 object-contain p-px', className)}
      style={style}
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}
