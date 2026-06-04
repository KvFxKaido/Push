/**
 * Client wrapper for the repo-coverage probe (auth rework step 2).
 *
 * Asks the Worker whether the Push GitHub App installation covers a repo before
 * a sandbox clone, so the UI can show an actionable install/update prompt
 * instead of letting the clone fail cryptically inside the container.
 *
 * Fails OPEN: any non-OK response or network error resolves to `unknown` rather
 * than `not_covered`, so a flaky probe never blocks a sandbox — the clone itself
 * remains the backstop for a real access failure.
 */

import { resolveApiUrl } from './api-url';
import type { RepoCoverage } from './sandbox-auth-gate';

export interface RepoCoverageProbe {
  coverage: RepoCoverage;
  /** GitHub install/configure URL to route the user to when not covered. */
  installUrl?: string;
}

export async function checkRepoCoverage(repo: string): Promise<RepoCoverageProbe> {
  try {
    const res = await fetch(resolveApiUrl('/api/github/repo-coverage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    if (!res.ok) return { coverage: 'unknown' };
    const data = (await res.json()) as { covered?: unknown; install_url?: unknown };
    const installUrl = typeof data.install_url === 'string' ? data.install_url : undefined;
    return { coverage: data.covered === true ? 'covered' : 'not_covered', installUrl };
  } catch {
    return { coverage: 'unknown' };
  }
}
