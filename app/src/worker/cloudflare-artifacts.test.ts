import { describe, expect, it, vi } from 'vitest';
import {
  authenticatedArtifactRemote,
  reapExpiredArtifactRepos,
  validateArtifactBackup,
  waitForArtifactRepo,
} from './cloudflare-artifacts';

describe('Cloudflare Artifacts lifecycle', () => {
  it('waits for an asynchronous import but does not retry an auth failure', async () => {
    vi.useFakeTimers();
    try {
      const repo = {};
      const get = vi
        .fn()
        .mockRejectedValueOnce({ code: 'IMPORT_IN_PROGRESS' })
        .mockResolvedValueOnce(repo);
      const pending = waitForArtifactRepo({ get } as never, 'source');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe(repo);
      get.mockReset().mockRejectedValue({ code: 'REMOTE_AUTH_REQUIRED' });
      await expect(waitForArtifactRepo({ get } as never, 'private')).rejects.toEqual({
        code: 'REMOTE_AUTH_REQUIRED',
      });
      expect(get).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an expired source repository while its sandbox lease is active', async () => {
    const remove = vi.fn();
    const list = vi.fn(async () => ({
      repos: [{ name: 'push-source-100-12345678-1234-1234-1234-123456789012' }],
    }));
    const get = vi.fn(async () => 'active');
    expect(
      await reapExpiredArtifactRepos({ list, delete: remove } as never, 500, { get } as never),
    ).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
  it('rejects foreign remotes and URL credentials', () => {
    expect(() => authenticatedArtifactRemote('https://evil.example/repo', 'secret')).toThrow();
    expect(() =>
      authenticatedArtifactRemote('http://artifacts.cloudflare.net/ns/repo', 'secret'),
    ).toThrow();
    expect(
      authenticatedArtifactRemote('https://artifacts.cloudflare.net/ns/repo', 'secret?expires=123'),
    ).toBe('https://x:secret@artifacts.cloudflare.net/ns/repo');
  });

  it('accepts the account-scoped remote the binding actually returns', () => {
    // Shape from the binding/REST docs: https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<ns>/<repo>.git
    const account = '0123456789abcdef0123456789abcdef';
    expect(
      authenticatedArtifactRemote(
        `https://${account}.artifacts.cloudflare.net/git/push-staging/repo.git`,
        'secret?expires=123',
      ),
    ).toBe(`https://x:secret@${account}.artifacts.cloudflare.net/git/push-staging/repo.git`);
    for (const host of [
      'evil.artifacts.cloudflare.net.example',
      'a.b.artifacts.cloudflare.net',
      'evilartifacts.cloudflare.net',
    ]) {
      expect(() => authenticatedArtifactRemote(`https://${host}/git/ns/repo.git`, 's')).toThrow();
    }
  });

  it('rejects expired and malformed restore handles before remote access', () => {
    const handle = {
      format: 'push-artifacts-v1' as const,
      id: 'push-checkpoint-123-12345678-1234-1234-1234-123456789012',
      dir: '/tmp/restore',
      commit: 'a'.repeat(40),
      expiresAt: '2000-01-01T00:00:00Z',
    };
    expect(() => validateArtifactBackup(handle)).toThrow('BACKUP_EXPIRED');
    expect(() => validateArtifactBackup({ ...handle, id: '../another-repo' })).toThrow(
      'INVALID_BACKUP_CONFIG',
    );
  });

  it('reaps only expired Push repos across pages, including abandoned uploads', async () => {
    const suffix = '12345678-1234-1234-1234-123456789012';
    const expired = `push-checkpoint-100-${suffix}`;
    const source = `push-source-200-${suffix}`;
    const remove = vi.fn(async () => true);
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        repos: [{ name: expired }, { name: 'customer-repo' }],
        cursor: 'next',
      })
      .mockResolvedValueOnce({
        repos: [{ name: source }, { name: `push-checkpoint-900-${suffix}` }],
      });
    expect(await reapExpiredArtifactRepos({ list, delete: remove } as never, 500)).toBe(2);
    expect(remove.mock.calls).toEqual([[expired], [source]]);
    expect(list).toHaveBeenLastCalledWith({ limit: 100, cursor: 'next' });
  });
});
