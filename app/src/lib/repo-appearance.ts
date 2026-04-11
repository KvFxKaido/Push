export type RepoAppearanceIconId =
  | 'repo-ledger'
  | 'robot-bot'
  | 'mobile-slab'
  | 'terminal-crate'
  | 'api-nodes'
  | 'docs-leaf';

export type RepoAppearanceColorId =
  | 'slate'
  | 'sky'
  | 'teal'
  | 'emerald'
  | 'amber'
  | 'coral'
  | 'rose'
  | 'indigo';

export interface RepoAppearance {
  icon: RepoAppearanceIconId;
  color: RepoAppearanceColorId;
}

export const DEFAULT_REPO_APPEARANCE: RepoAppearance = {
  icon: 'repo-ledger',
  color: 'slate',
};

export const REPO_APPEARANCE_ICON_OPTIONS: Array<{ id: RepoAppearanceIconId; label: string }> = [
  { id: 'repo-ledger', label: 'Ledger' },
  { id: 'robot-bot', label: 'Robot' },
  { id: 'mobile-slab', label: 'Phone' },
  { id: 'terminal-crate', label: 'Terminal' },
  { id: 'api-nodes', label: 'API' },
  { id: 'docs-leaf', label: 'Docs' },
];

export const REPO_APPEARANCE_COLOR_OPTIONS: Array<{
  id: RepoAppearanceColorId;
  label: string;
  hex: string;
}> = [
  { id: 'slate', label: 'Slate', hex: '#94a3b8' },
  { id: 'sky', label: 'Sky', hex: '#7dd3fc' },
  { id: 'teal', label: 'Teal', hex: '#5eead4' },
  { id: 'emerald', label: 'Emerald', hex: '#86efac' },
  { id: 'amber', label: 'Amber', hex: '#fcd34d' },
  { id: 'coral', label: 'Coral', hex: '#fda4af' },
  { id: 'rose', label: 'Rose', hex: '#fb7185' },
  { id: 'indigo', label: 'Indigo', hex: '#a5b4fc' },
];

const ICON_ID_SET = new Set<RepoAppearanceIconId>(
  REPO_APPEARANCE_ICON_OPTIONS.map((option) => option.id),
);
const COLOR_ID_SET = new Set<RepoAppearanceColorId>(
  REPO_APPEARANCE_COLOR_OPTIONS.map((option) => option.id),
);

export function isRepoAppearanceIconId(value: unknown): value is RepoAppearanceIconId {
  return typeof value === 'string' && ICON_ID_SET.has(value as RepoAppearanceIconId);
}

export function isRepoAppearanceColorId(value: unknown): value is RepoAppearanceColorId {
  return typeof value === 'string' && COLOR_ID_SET.has(value as RepoAppearanceColorId);
}

export function coerceRepoAppearance(value: unknown): RepoAppearance | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RepoAppearance>;
  if (!isRepoAppearanceIconId(candidate.icon) || !isRepoAppearanceColorId(candidate.color)) {
    return null;
  }
  return {
    icon: candidate.icon,
    color: candidate.color,
  };
}

export function getRepoAppearanceColorHex(colorId: RepoAppearanceColorId): string {
  return (
    REPO_APPEARANCE_COLOR_OPTIONS.find((option) => option.id === colorId)?.hex ??
    REPO_APPEARANCE_COLOR_OPTIONS.find((option) => option.id === DEFAULT_REPO_APPEARANCE.color)
      ?.hex ??
    '#94a3b8'
  );
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
