import type { CSSProperties, ReactNode } from 'react';
import { DottedGlowBackground } from '@/components/ui/dotted-glow-background';
import { hexToRgba, type RepoAppearanceGlowStyleId } from '@/lib/repo-appearance';

interface ChatBackgroundGlowProps {
  active: boolean;
  color: string;
  /** Which glow treatment to render. Defaults to the gradient wash. */
  variant?: RepoAppearanceGlowStyleId;
}

// ── Ambient background standard ───────────────────────────────────────────
// Every chat-surface background composes the same three pieces so the chrome
// stays legible and the variants stay visually consistent. A *textured*
// background (the dot field today; any future grid / aurora / scanline) must:
//   1. render <ChatGlowTopBarWash/> — soft gradient blobs behind the app bar,
//   2. mask the texture with BACKGROUND_TOPBAR_CLEAR_MASK so dense texture
//      never sits directly under the app-bar chrome, and
//   3. render <ChatGlowBottomFade/> — fade the texture into the composer.
// The plain "gradient" variant is just the wash + bottom fade (no texture, so
// no mask). See DESIGN.md → "Ambient backgrounds (chat surface)".

// Clears a textured background out from under the app bar: fully transparent
// for the first ~5rem (status bar + header), ramping to opaque by ~12rem so
// there is no hard seam where the texture begins.
export const BACKGROUND_TOPBAR_CLEAR_MASK =
  'linear-gradient(to bottom, transparent 0, transparent 5rem, black 12rem)';

export function ChatBackgroundGlow({
  active,
  color,
  variant = 'gradient',
}: ChatBackgroundGlowProps) {
  const containerStyle = {
    '--push-glow-strong': hexToRgba(color, 0.14),
    '--push-glow-soft': hexToRgba(color, 0.06),
    // Dotted texture reads from its own accent pair; harmless for the gradient
    // variant, which ignores them.
    '--push-glow-dot': hexToRgba(color, 0.55),
    '--push-glow-dot-glow': hexToRgba(color, 0.95),
    opacity: active ? 1 : 0,
  } as CSSProperties;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden transition-opacity duration-1000 ease-out"
      style={containerStyle}
    >
      <ChatGlowTopBarWash active={active} />
      {variant === 'dotted' && active && (
        <div
          className="absolute inset-0"
          style={{
            maskImage: BACKGROUND_TOPBAR_CLEAR_MASK,
            WebkitMaskImage: BACKGROUND_TOPBAR_CLEAR_MASK,
          }}
        >
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
      <ChatGlowBottomFade />
    </div>
  );
}

// The soft accent wash: two large blurred blobs anchored to the top of the
// surface. It is both the whole "gradient" identity and — for textured
// variants — the legibility wash that sits behind the app bar. Reads
// `--push-glow-strong` / `--push-glow-soft` from an ancestor.
//
// The drift keyframes pause when the glow is hidden so the compositor doesn't
// keep two large blurred transforms animating for the rest of the chat
// session — matters most on battery-sensitive mobile devices.
function ChatGlowTopBarWash({ active }: { active: boolean }) {
  const blobStyle: CSSProperties = {
    animationPlayState: active ? 'running' : 'paused',
  };
  return (
    <>
      <div className="push-glow-blob push-glow-blob-primary" style={blobStyle} />
      <div className="push-glow-blob push-glow-blob-secondary" style={blobStyle} />
    </>
  );
}

// Fades the background into black toward the composer so the message area and
// input stay legible regardless of the texture above.
function ChatGlowBottomFade(): ReactNode {
  return (
    <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black via-black/85 to-transparent" />
  );
}
