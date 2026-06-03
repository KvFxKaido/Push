import type { CSSProperties } from 'react';
import { hexToRgba } from '@/lib/repo-appearance';

interface ChatBackgroundGlowProps {
  active: boolean;
  color: string;
}

export function ChatBackgroundGlow({ active, color }: ChatBackgroundGlowProps) {
  const containerStyle = {
    '--push-glow-strong': hexToRgba(color, 0.14),
    '--push-glow-soft': hexToRgba(color, 0.06),
    opacity: active ? 1 : 0,
  } as CSSProperties;

  // Pause the drift keyframes when the glow is hidden so the compositor
  // doesn't keep two large blurred transforms animating for the rest of
  // the chat session — matters most on battery-sensitive mobile devices.
  const blobStyle: CSSProperties = {
    animationPlayState: active ? 'running' : 'paused',
  };

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden transition-opacity duration-1000 ease-out"
      style={containerStyle}
    >
      <div className="push-glow-blob push-glow-blob-primary" style={blobStyle} />
      <div className="push-glow-blob push-glow-blob-secondary" style={blobStyle} />
      <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black via-black/85 to-transparent" />
    </div>
  );
}
