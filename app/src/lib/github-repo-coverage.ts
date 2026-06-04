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
import { getActiveInstallationId } from './github-auth';
import type { RepoCoverage } from './sandbox-auth-gate';

export interface RepoCoverageProbe {
  coverage: RepoCoverage;
  /** GitHub install/configure URL to route the user to when not covered. */
  installUrl?: string;
}

export async function checkRepoCoverage(repo: string): Promise<RepoCoverageProbe> {
  try {
    // Send the active installation id so the server can confirm the repo is
    // covered by *this* installation — the one whose token useSandbox injects —
    // not merely by some installation of the App (multi-install correctness).
    const installationId = getActiveInstallationId();
    const res = await fetch(resolveApiUrl('/api/github/repo-coverage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo,
        ...(installationId ? { installation_id: installationId } : {}),
      }),
    });
    if (!res.ok) return { coverage: 'unknown' };
    const data = (await res.json()) as { covered?: unknown; install_url?: unknown };
    const installUrl = typeof data.install_url === 'string' ? data.install_url : undefined;
    // Fail open: only an explicit `false` blocks; any other/unexpected shape is
    // `unknown` (allow), so schema drift never falsely blocks a sandbox.
    const coverage: RepoCoverage =
      data.covered === true ? 'covered' : data.covered === false ? 'not_covered' : 'unknown';
    return { coverage, installUrl };
  } catch {
    return { coverage: 'unknown' };
  }
}
