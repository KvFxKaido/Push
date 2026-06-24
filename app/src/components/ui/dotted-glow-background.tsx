import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface DottedGlowBackgroundProps {
  className?: string;
  /** Overall canvas opacity multiplier (0–1). */
  opacity?: number;
  /** Distance in CSS pixels between dot centers. */
  gap?: number;
  /** Dot radius in CSS pixels. */
  radius?: number;
  /** CSS custom-property names resolved for the resting dot color. */
  colorLightVar?: string;
  colorDarkVar?: string;
  /** CSS custom-property names resolved for the pulsing glow color. */
  glowColorLightVar?: string;
  glowColorDarkVar?: string;
  /** Opacity (0–1) of a flat color wash drawn behind the dots. */
  backgroundOpacity?: number;
  /** Per-dot pulse speed range; each dot picks a value in [min, max]. */
  speedMin?: number;
  speedMax?: number;
  /** Global multiplier applied to every dot's pulse speed. */
  speedScale?: number;
}

interface Dot {
  x: number;
  y: number;
  phase: number;
  speed: number;
}

function resolveVar(el: Element, varName: string | undefined, fallback: string): string {
  if (!varName) return fallback;
  const value = getComputedStyle(el).getPropertyValue(varName).trim();
  return value || fallback;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.classList.contains('dark')) return true;
  if (document.documentElement.classList.contains('light')) return false;
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/**
 * DottedGlowBackground — a canvas grid of dots whose brightness drifts in and
 * out, lit by an accent "glow" color. Colors are resolved from CSS custom
 * properties (light/dark pairs) so the layer tracks the active theme, and the
 * whole thing freezes to a single static frame under `prefers-reduced-motion`.
 *
 * Drawn behind content; mark the host `pointer-events-none` and mask it with
 * Tailwind's radial mask utilities for an ambient vignette.
 */
export function DottedGlowBackground({
  className,
  opacity = 1,
  gap = 12,
  radius = 1.4,
  colorLightVar,
  colorDarkVar,
  glowColorLightVar,
  glowColorDarkVar,
  backgroundOpacity = 0,
  speedMin = 0.3,
  speedMax = 1.6,
  speedScale = 1,
}: DottedGlowBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Stash animation params in a ref so the long-lived rAF loop reads live
  // values without restarting on every prop change. Written from an effect
  // (never during render) so React's ref rules stay satisfied.
  const paramsRef = useRef({
    opacity,
    gap,
    radius,
    colorLightVar,
    colorDarkVar,
    glowColorLightVar,
    glowColorDarkVar,
    backgroundOpacity,
    speedMin,
    speedMax,
    speedScale,
  });

  useEffect(() => {
    paramsRef.current = {
      opacity,
      gap,
      radius,
      colorLightVar,
      colorDarkVar,
      glowColorLightVar,
      glowColorDarkVar,
      backgroundOpacity,
      speedMin,
      speedMax,
      speedScale,
    };
  }, [
    opacity,
    gap,
    radius,
    colorLightVar,
    colorDarkVar,
    glowColorLightVar,
    glowColorDarkVar,
    backgroundOpacity,
    speedMin,
    speedMax,
    speedScale,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let rafId = 0;
    let baseColor = '#94a3b8';
    let glowColor = '#7dd3fc';
    let startTime: number | null = null;

    const resolveColors = () => {
      const dark = isDarkTheme();
      const p = paramsRef.current;
      baseColor = resolveVar(canvas, dark ? p.colorDarkVar : p.colorLightVar, '#94a3b8');
      glowColor = resolveVar(canvas, dark ? p.glowColorDarkVar : p.glowColorLightVar, '#7dd3fc');
    };

    const buildDots = () => {
      const p = paramsRef.current;
      const gapPx = Math.max(2, p.gap);
      const span = p.speedMax - p.speedMin;
      const next: Dot[] = [];
      // Deterministic, seed-free jitter so dots don't all pulse in lockstep
      // (Math.random is unavailable in some of this repo's runtimes).
      let seed = 1;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let y = gapPx / 2; y < height; y += gapPx) {
        for (let x = gapPx / 2; x < width; x += gapPx) {
          next.push({
            x,
            y,
            phase: rand() * Math.PI * 2,
            speed: (p.speedMin + rand() * span) * p.speedScale,
          });
        }
      }
      dots = next;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resolveColors();
      buildDots();
    };

    const draw = (elapsed: number) => {
      const p = paramsRef.current;
      ctx.clearRect(0, 0, width, height);

      if (p.backgroundOpacity > 0) {
        ctx.globalAlpha = p.backgroundOpacity * p.opacity;
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, 0, width, height);
      }

      const t = elapsed / 1000;
      for (const dot of dots) {
        // Sparse glow: bias the pulse so most dots sit dim and a few flare up.
        const wave = (Math.sin(t * dot.speed + dot.phase) + 1) / 2;
        const intensity = wave * wave;

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, p.radius, 0, Math.PI * 2);
        ctx.globalAlpha = p.opacity * (0.3 + intensity * 0.7);
        ctx.fillStyle = intensity > 0.45 ? glowColor : baseColor;
        if (intensity > 0.45) {
          ctx.shadowBlur = p.radius * 4 * intensity;
          ctx.shadowColor = glowColor;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };

    const reducedMotion = prefersReducedMotion();

    const loop = (now: number) => {
      if (startTime === null) startTime = now;
      draw(now - startTime);
      rafId = window.requestAnimationFrame(loop);
    };

    resize();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => resize())
        : null;
    resizeObserver?.observe(canvas);

    // Re-resolve colors when the document theme class flips.
    const themeObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => resolveColors())
        : null;
    if (typeof document !== 'undefined') {
      themeObserver?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    if (reducedMotion) {
      // Freeze at a representative frame so the layer still reads as "dotted"
      // without animating.
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn('absolute inset-0 h-full w-full', className)}
    />
  );
}
