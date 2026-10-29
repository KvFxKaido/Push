import type { Artifacts, ArtifactsRepo, KVNamespace } from '@cloudflare/workers-types';

/** Import is asynchronous; only poll its explicit in-progress state. */
export async function waitForArtifactRepo(
  artifacts: Artifacts,
  name: string,
): Promise<ArtifactsRepo & Disposable> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await artifacts.get(name)) as ArtifactsRepo & Disposable;
    } catch (error) {
      const code = (error as { code?: string | number })?.code;
      if (attempt >= 19 || (code !== 'IMPORT_IN_PROGRESS' && code !== 10302)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Cloudflare Artifacts checkpoint; unrelated to the renderable-artifact KV store. */
export interface ArtifactBackupHandle {
  format: 'push-artifacts-v1';
  id: string;
  dir: string;
  commit: string;
  expiresAt: string;
}

export const ARTIFACT_REPO_PREFIX = 'push-checkpoint-';
export const ARTIFACT_SOURCE_PREFIX = 'push-source-';

export function artifactRepoName(prefix: string, expiresAt: number): string {
  return `${prefix}${expiresAt}-${crypto.randomUUID()}`;
}

export function validateArtifactBackup(handle: ArtifactBackupHandle): void {
  if (
    !/^push-checkpoint-\d+-[0-9a-f-]{36}$/.test(handle.id) ||
    !/^[0-9a-f]{40}$/.test(handle.commit) ||
    !Number.isFinite(Date.parse(handle.expiresAt))
  )
    throw new Error('INVALID_BACKUP_CONFIG: Invalid Artifacts checkpoint');
  if (Date.parse(handle.expiresAt) <= Date.now() + 60_000) {
    throw new Error('BACKUP_EXPIRED: Artifacts checkpoint expired');
  }
}

export function authenticatedArtifactRemote(remote: string, token: string): string {
  const url = new URL(remote);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'artifacts.cloudflare.net' ||
    url.username ||
    url.password
  ) {
    throw new Error('INVALID_BACKUP_CONFIG: Invalid Artifacts remote');
  }
  url.username = 'x';
  url.password = token.split('?expires=')[0];
  return url.toString();
}

/** Names carry absolute expiry so abandoned uploads are reclaimable too. */
export async function reapExpiredArtifactRepos(
  artifacts: Artifacts,
  now = Date.now(),
  leases?: KVNamespace,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await artifacts.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const repo of page.repos) {
      const match = /^push-(?:checkpoint|source)-(\d+)-[0-9a-f-]{36}$/.exec(repo.name);
      if (
        repo.name.startsWith(ARTIFACT_SOURCE_PREFIX) &&
        leases &&
        (await leases.get(`artifact-lease:${repo.name}`))
      )
        continue;
      if (match && Number(match[1]) < now && (await artifacts.delete(repo.name))) deleted++;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return deleted;
}
