import { type CSSProperties, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export interface BackgroundRippleEffectProps {
  /** Number of grid rows. */
  rows?: number;
  /** Number of grid columns. */
  cols?: number;
  /** Cell edge length in CSS pixels. */
  cellSize?: number;
  className?: string;
  /**
   * When false, cells ignore pointer events — the ambient-background use, where
   * chat content sits on top and the layer is only decorative. Defaults to true
   * so the standalone demo stays interactive (hover + click to ripple).
   */
  interactive?: boolean;
  /**
   * Origin of the entrance ripple that plays once on mount. `'center'` resolves
   * to the middle cell; pass explicit coords or `null` to start with no ripple.
   */
  initialRipple?: { row: number; col: number } | 'center' | null;
}

// Per-cell CSS custom properties consumed by the `cell-ripple` keyframe
// (defined in index.css). The radial distance from the origin feeds `--delay`
// so the flash expands outward; `--duration` stretches with distance so the
// far edge fades a touch slower.
type CellStyle = CSSProperties & {
  '--delay'?: string;
  '--duration'?: string;
};

// Vignette that dissolves the fixed-size grid into its surroundings so the cell
// rectangle never shows a hard edge: fully opaque at the center, fully clear by
// 85% of the radius (the last ~15% is the fade band). Applied as the grid's
// mask. Named for the same reason BACKGROUND_TOPBAR_CLEAR_MASK is — so the
// percentage reads as an intentional fade boundary, not a magic number.
const RIPPLE_VIGNETTE_MASK = 'radial-gradient(circle at center, black, transparent 85%)';

interface DivGridProps {
  rows: number;
  cols: number;
  cellSize: number;
  clickedCell: { row: number; col: number } | null;
  onCellClick: (row: number, col: number) => void;
  interactive: boolean;
  className?: string;
}

function DivGrid({
  rows,
  cols,
  cellSize,
  clickedCell,
  onCellClick,
  interactive,
  className,
}: DivGridProps) {
  const cells = useMemo(
    () => Array.from({ length: rows * cols }, (_, idx) => idx),
    [rows, cols],
  );

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
    gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
    width: cols * cellSize,
    height: rows * cellSize,
    marginInline: 'auto',
    maskImage: RIPPLE_VIGNETTE_MASK,
    WebkitMaskImage: RIPPLE_VIGNETTE_MASK,
  };

  return (
    <div className={cn('relative z-[1]', className)} style={gridStyle}>
      {cells.map((idx) => {
        const rowIdx = Math.floor(idx / cols);
        const colIdx = idx % cols;
        const distance = clickedCell
          ? Math.hypot(clickedCell.row - rowIdx, clickedCell.col - colIdx)
          : 0;
        const delay = clickedCell ? Math.max(0, distance * 55) : 0;
        const duration = 220 + distance * 80;
        const cellStyle: CellStyle = clickedCell
          ? { '--delay': `${delay}ms`, '--duration': `${duration}ms` }
          : {};

        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the grid is a fixed,
            // order-stable list keyed by position; index is the position.
            key={idx}
            className={cn(
              'cell border-[0.5px] opacity-40 transition-opacity duration-150 will-change-[background-color]',
              interactive ? 'hover:opacity-80' : 'pointer-events-none',
              clickedCell && 'animate-cell-ripple',
            )}
            style={{
              backgroundColor: 'var(--cell-fill-color)',
              borderColor: 'var(--cell-border-color)',
              ...cellStyle,
            }}
            onClick={interactive ? () => onCellClick(rowIdx, colIdx) : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * BackgroundRippleEffect — a grid of cells that flash outward in a ripple from
 * a click (or the entrance origin). Colors are driven by CSS custom properties
 * (`--cell-fill-color` / `--cell-border-color` / `--cell-ripple-color`) so a
 * host can tint the layer with its accent; the defaults track the neutral
 * theme. Drawn full-bleed inside its positioned parent.
 *
 * In Push this is the `ripple` ambient-background variant (see
 * `ChatBackgroundGlow`), rendered non-interactive behind chat content. The
 * exported component stays interactive by default for standalone use.
 */
export function BackgroundRippleEffect({
  rows = 8,
  cols = 27,
  cellSize = 56,
  className,
  interactive = true,
  initialRipple = 'center',
}: BackgroundRippleEffectProps) {
  const [clickedCell, setClickedCell] = useState<{ row: number; col: number } | null>(() => {
    if (initialRipple === 'center') {
      return { row: Math.floor(rows / 2), col: Math.floor(cols / 2) };
    }
    return initialRipple ?? null;
  });
  // Remounts the grid so a fresh click replays the ripple from a clean state
  // even when the same cell is clicked twice in a row.
  const [rippleKey, setRippleKey] = useState(0);

  return (
    <div
      className={cn(
        'absolute inset-0 h-full w-full',
        // Resting + flash colors. A host (e.g. ChatBackgroundGlow) overrides the
        // `--push-ripple-*` vars with its live accent; these fallbacks keep the
        // standalone demo legible on both themes.
        '[--cell-fill-color:var(--push-ripple-fill,rgba(125,211,252,0.08))]',
        '[--cell-border-color:var(--push-ripple-border,rgba(125,211,252,0.20))]',
        '[--cell-ripple-color:var(--push-ripple-glow,rgba(125,211,252,0.55))]',
        className,
      )}
    >
      <div className="relative h-full w-full overflow-hidden">
        <DivGrid
          key={`ripple-${rippleKey}`}
          rows={rows}
          cols={cols}
          cellSize={cellSize}
          clickedCell={clickedCell}
          interactive={interactive}
          onCellClick={(row, col) => {
            setClickedCell({ row, col });
            setRippleKey((key) => key + 1);
          }}
        />
      </div>
    </div>
  );
}
