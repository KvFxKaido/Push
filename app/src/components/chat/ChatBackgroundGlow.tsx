import type { CSSProperties } from 'react';
import { DottedGlowBackground } from '@/components/ui/dotted-glow-background';
import { hexToRgba, type RepoAppearanceGlowStyleId } from '@/lib/repo-appearance';

interface ChatBackgroundGlowProps {
  active: boolean;
  color: string;
  /** Which glow treatment to render. Defaults to the gradient wash. */
  variant?: RepoAppearanceGlowStyleId;
}

export function ChatBackgroundGlow({
  active,
  color,
  variant = 'gradient',
}: ChatBackgroundGlowProps) {
  if (variant === 'dotted') {
    return <DottedChatGlow active={active} color={color} />;
  }

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

// The dotted treatment paints the accent into the dot field via two CSS
// variables the canvas resolves; the same bottom fade keeps the message
// area legible. We unmount the canvas entirely when inactive so the rAF
// loop stops rather than animating an invisible layer.
//
// The top bar is a deliberate cheat: dense dots directly behind the app-bar
// chrome (repo name, tab pills, icons) hurt legibility, so we clear the dots
// out of the top strip and lay the *gradient* blobs there instead — the header
// reads over a soft accent wash while the rest of the surface stays dotted.
function DottedChatGlow({ active, color }: { active: boolean; color: string }) {
  const containerStyle = {
    '--push-glow-dot': hexToRgba(color, 0.55),
    '--push-glow-dot-glow': hexToRgba(color, 0.95),
    // Feed the shared gradient blobs too — they provide the top-bar wash.
    '--push-glow-strong': hexToRgba(color, 0.14),
    '--push-glow-soft': hexToRgba(color, 0.06),
    opacity: active ? 1 : 0,
  } as CSSProperties;

  const blobStyle: CSSProperties = {
    animationPlayState: active ? 'running' : 'paused',
  };

  // Fade the dot field in below the app bar: fully clear for the first ~5rem
  // (status bar + header), ramping to full by ~12rem so there's no hard seam.
  const dotMask = 'linear-gradient(to bottom, transparent 0, transparent 5rem, black 12rem)';

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden transition-opacity duration-1000 ease-out"
      style={containerStyle}
    >
      {/* Gradient wash behind the top bar for chrome legibility. */}
      <div className="push-glow-blob push-glow-blob-primary" style={blobStyle} />
      <div className="push-glow-blob push-glow-blob-secondary" style={blobStyle} />
      {active && (
        <div className="absolute inset-0" style={{ maskImage: dotMask, WebkitMaskImage: dotMask }}>
          <DottedGlowBackground
            opacity={1}
            gap={18}
            radius={1.5}
            colorLightVar="--push-glow-dot"
            glowColorLightVar="--push-glow-dot-glow"
            colorDarkVar="--push-glow-dot"
            glowColorDarkVar="--push-glow-dot-glow"
            backgroundOpacity={0}
            speedMin={0.3}
            speedMax={1.6}
            speedScale={1}
            // The var names are constant; the accent feeding them is not. Key the
            // re-resolve on the live color so edits track without a remount.
            colorKey={color}
          />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black via-black/85 to-transparent" />
    </div>
  );
}
