import type { JSX, SVGProps } from 'react';
import { cn } from '@/lib/utils';
import {
  ApiNodesIcon,
  DocsLeafIcon,
  MobileSlabIcon,
  RepoLedgerIcon,
  RobotBotIcon,
  TerminalCrateIcon,
} from '@/components/icons/push-custom-icons';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  type RepoAppearance,
  type RepoAppearanceIconId,
} from '@/lib/repo-appearance';

type IconProps = SVGProps<SVGSVGElement>;

const ICON_REGISTRY: Record<RepoAppearanceIconId, (props: IconProps) => JSX.Element> = {
  'repo-ledger': RepoLedgerIcon,
  'robot-bot': RobotBotIcon,
  'mobile-slab': MobileSlabIcon,
  'terminal-crate': TerminalCrateIcon,
  'api-nodes': ApiNodesIcon,
  'docs-leaf': DocsLeafIcon,
};

export function RepoAppearanceGlyph({
  icon,
  ...props
}: { icon: RepoAppearanceIconId } & IconProps) {
  const Component = ICON_REGISTRY[icon];
  return <Component {...props} />;
}

export function RepoAppearanceBadge({
  appearance,
  className,
  iconClassName,
}: {
  appearance?: RepoAppearance | null;
  className?: string;
  iconClassName?: string;
}) {
  const resolved = appearance ?? DEFAULT_REPO_APPEARANCE;
  const colorHex = getRepoAppearanceColorHex(resolved.color);

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center',
        className,
      )}
      style={{
        color: colorHex,
      }}
    >
      <RepoAppearanceGlyph icon={resolved.icon} className={cn('h-3.5 w-3.5', iconClassName)} />
    </span>
  );
}
