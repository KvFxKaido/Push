import type { CSSProperties } from 'react';
import { hexToRgba } from '@/lib/repo-appearance';

interface ChatBackgroundGlowProps {
  active: boolean;
  color: string;
}

export function ChatBackgroundGlow({ active, color }: ChatBackgroundGlowProps) {
  const style = {
    '--push-glow-strong': hexToRgba(color, 0.55),
    '--push-glow-soft': hexToRgba(color, 0.28),
    opacity: active ? 1 : 0,
  } as CSSProperties;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden transition-opacity duration-1000 ease-out"
      style={style}
    >
      <div className="push-glow-blob push-glow-blob-primary" />
      <div className="push-glow-blob push-glow-blob-secondary" />
      <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black via-black/85 to-transparent" />
    </div>
  );
}
