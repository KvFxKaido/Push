import type { NativeFsDiffResult } from './native-fs';
import { isSensitivePath, redactSensitiveText } from './sensitive-data-guard';

/**
 * The native working-copy diff includes untracked files as additions so commit
 * preview/stats see the same files JGit will stage. It can carry contents no
 * other native read path would return raw, so apply the same defenses as
 * read/search: drop whole blocks for sensitive paths, value-redact the rest.
 */
export function sanitizeNativeDiff(result: NativeFsDiffResult): NativeFsDiffResult {
  // Porcelain status names files too (`?? .env`) — filter it with the same
  // rule as the diff body so a consumer that prints git_status (the diff
  // handler's empty-diff branch does, and the commit handler's status lines
  // would) can't leak what the diff hides. Filtered even when the diff body
  // is empty — that IS the branch that prints status.
  const gitStatus = result.git_status
    ?.split('\n')
    .filter((line) => {
      if (!line || line.startsWith('##')) return true;
      // XY <path> (renames: `XY old -> new`) — drop the line if any named
      // path is sensitive.
      const paths = line.slice(3).split(' -> ');
      return !paths.some((p) => p.trim() && isSensitivePath(p.trim()));
    })
    .join('\n');
  const withStatus = (value: NativeFsDiffResult): NativeFsDiffResult => ({
    ...value,
    ...(result.git_status !== undefined ? { git_status: gitStatus } : {}),
  });
  if (!result.diff) return withStatus(result);
  let hidden = 0;
  const kept = result.diff.split(/^(?=diff --git )/m).filter((block) => {
    const header = /^diff --git a\/(\S+) /.exec(block);
    if (header && isSensitivePath(header[1])) {
      hidden += 1;
      return false;
    }
    return true;
  });
  const redaction = redactSensitiveText(kept.join(''));
  const notes = [
    ...(hidden > 0 ? [`[${hidden} sensitive file diff${hidden === 1 ? '' : 's'} hidden]`] : []),
    ...(redaction.redacted ? ['[secret-like values redacted]'] : []),
  ];
  const diff = [redaction.text.trimEnd(), ...notes].filter(Boolean).join('\n');
  return withStatus({ ...result, diff });
}
