import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

export function PushOrbitIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="2" />
      <path d="M16.62 10.09a5 5 0 1 1-2.71-2.71" />
      <path d="M19.39 8.94a8 8 0 1 1-4.33-4.33" />
      <path d="M14.5 9.5L21 3M17 3h4v4" />
    </svg>
  );
}

export function BranchWaveIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="9" r="2" />
      <circle cx="18" cy="15" r="2" />
      <path d="M6 6v12M18 11v2M8 20c6 0 10-2 10-3M18 7c0-1-4-3-10-3" />
    </svg>
  );
}

export function SandboxCubeIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M18 12v5l-7 4-7-4v-5m7 9v-5M4 12l7 4 7-4M4 12l7-4 7 4M11 8v5" />
      <path d="M18 2q0 3 3 3-3 0-3 3 0-3-3-3 3 0 3-3Z" />
      <path d="M6 4.5q0 1.5 1.5 1.5Q6 6 6 7.5 6 6 4.5 6 6 6 6 4.5Z" />
    </svg>
  );
}

export function MergeShieldIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="M8 16v-2c0-3 4-3 4-6V6" />
      <path d="M16 16v-2c0-3-4-3-4-6" />
      <path d="m9 9 3-3 3 3" />
    </svg>
  );
}

export function LivePipelineIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="9" y="2" width="6" height="4" rx="1.5" />
      <line x1="12" y1="6" x2="12" y2="9" />
      <rect x="4" y="9" width="16" height="6" rx="2" />
      <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <line x1="12" y1="12" x2="16" y2="12" />
      <line x1="12" y1="15" x2="12" y2="18" />
      <rect x="9" y="18" width="6" height="4" rx="1.5" />
    </svg>
  );
}

export function LauncherGridIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M6 6.5h1" />
    </svg>
  );
}

export function WorkspaceDockIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M14 3v18" />
      <rect x="16" y="5" width="3" height="6" rx="1" />
      <rect x="16" y="13" width="3" height="6" rx="1" />
      <path d="M7 7h3" />
    </svg>
  );
}

export function NotebookPadIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="8" y1="3" x2="8" y2="21" />
      <line x1="12" y1="10" x2="16" y2="10" />
      <line x1="12" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function ReviewLensIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M14.95 14.95L21 21" />
      <path d="M7 10.5l2 2 4-4" />
      <path d="M17 5l2-2" />
      <path d="M20 8l2-2" />
    </svg>
  );
}

export function SettingsCellsIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="17" width="18" height="4" rx="1" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <circle cx="7" cy="12" r="2.5" />
      <path d="M11 5h6M11 12h4M11 19h7" />
    </svg>
  );
}

export function CommitPulseIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="6" cy="12" r="2" />
      <path d="M8 12h5" />
      <circle cx="14" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <path d="M17 12a3 3 0 0 0-3-3" />
      <path d="M17 12a3 3 0 0 1-3 3" />
      <path d="M19.5 12a5.5 5.5 0 0 0-5.5-5.5" />
      <path d="M19.5 12a5.5 5.5 0 0 1-5.5 5.5" />
    </svg>
  );
}

export function HistoryStackIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M7 3.5h8a2 2 0 0 1 2 2V7" />
      <path d="M7 3.5V5.2H5.3" />
      <path d="M6 7h10a2 2 0 0 1 2 2v1" />
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 13h8" />
      <path d="M8 16h5" />
    </svg>
  );
}

export function PRThreadIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="5" cy="7" r="1.5" />
      <circle cx="5" cy="17" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
      <path d="M6.5 7c4.5 0 8 1.8 11 5" />
      <path d="M6.5 17c4.5 0 8-1.8 11-5" />
      <path d="M10 5.5h3" />
      <path d="M10 18.5h3" />
      <path d="M19 10v4" />
    </svg>
  );
}

export function RepoLedgerIcon({ strokeWidth = 2, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M7 4.5h10a2 2 0 0 1 2 2V19a1.5 1.5 0 0 1-1.5 1.5H9a2 2 0 0 0-2 2V6.5a2 2 0 0 1 2-2Z" />
      <path d="M7 7H5.5A1.5 1.5 0 0 0 4 8.5v11A1.5 1.5 0 0 0 5.5 21H7" />
      <path d="M9.5 4.5v16" />
      <path d="M12.5 9H16" />
      <path d="M12.5 13h3" />
      <path d="M12.5 17h4" />
    </svg>
  );
}
