import { useState } from 'react';
import demoIcon from '@/assets/icons/push-pack-v1/push-orbit.svg';
import { cn } from '@/lib/utils';
import type { AIProviderType } from '@/types';
import { findProviderDefinition } from '@push/lib/provider-definition';

const DEMO_ICON = {
  src: demoIcon,
  alt: 'Push logo',
  fallbackText: 'P',
} as const;

interface ProviderIconProps {
  provider: AIProviderType;
  size?: number;
  className?: string;
}

function getProviderIcon(provider: AIProviderType) {
  if (provider === 'demo') return DEMO_ICON;
  const icon = findProviderDefinition(provider)?.icon;
  if (icon) return icon;
  return {
    src: '',
    alt: `${provider} logo`,
    fallbackText: provider.slice(0, 2).toUpperCase(),
  };
}

export function ProviderIcon({ provider, size = 14, className }: ProviderIconProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const { src, alt, fallbackText } = getProviderIcon(provider);
  const hasError = failedSrc === src;

  const style = { width: size, height: size };

  if (!src || hasError) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex items-center justify-center rounded-[4px] border border-push-edge bg-push-surface text-[8px] font-semibold leading-none text-push-fg-secondary',
          className,
        )}
        style={style}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={cn('inline-block rounded-[4px] bg-white/90 object-contain p-px', className)}
      style={style}
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}
