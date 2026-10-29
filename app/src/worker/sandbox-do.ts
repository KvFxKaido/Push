/**
 * Sandbox Durable Object for Cloudflare Sandbox SDK 1.0.
 *
 * SDK 1.0 removed the package's `Sandbox` class and `getSandbox()`; the app
 * now writes the Durable Object and drives the container through
 * `ctx.container`. This class is a **compatibility facade**: it exposes the
 * same small method set worker-cf-sandbox.ts called on the 0.12 handle, with
 * 0.12-shaped inputs and results, so the handler's 22 routes barely change.
 * The 1.0 differences are absorbed here:
 *
 * - `exec` runs without a shell in 1.0, defaults cwd to `/`, and passes only
 *   PATH through. The facade runs `bash -c`, defaults cwd to /workspace, and
 *   supplies a base environment (HOME is load-bearing: git's identity and
 *   corepack's cache live under /root).
 * - `Files.writeFile` no longer creates parent directories and writes in
 *   place; the facade does `mkdir -p` and a temp-file rename.
 * - `readDirectory` returns dotfiles; `listFiles` hides them, as 0.12 did.
 * - Background processes have no SDK equivalent; they're tracked in a
 *   per-process directory in the container.
 * - Backups use `DirectoryBackup`. A 0.12 SquashFS handle (no `format`) is
 *   refused as expired rather than converted: snapshots live at most seven
 *   days, so the cutover drops them instead of carrying a SquashFS reader.
 *
 * Errors that callers branch on carry their code in the message
 * (`CODE: detail`) as well as `.code`, because custom error properties
 * aren't guaranteed to survive Workers RPC.
 *
 * Plan: docs/decisions/Cloudflare Sandbox SDK 1.0 Migration.md.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupRecord,
  Files,
} from '@cloudflare/sandbox';
import type {
  ArtifactsRepo,
  Container,
  DurableObjectState,
  R2Bucket,
} from '@cloudflare/workers-types';
import type { Env } from './worker-middleware';
import {
  artifactFailureReason,
  artifactRepoName,
  authenticatedArtifactRemote,
  validateArtifactBackup,
  waitForArtifactRepo,
  ARTIFACT_REPO_PREFIX,
  ARTIFACT_SOURCE_PREFIX,
  type ArtifactBackupHandle,
} from './cloudflare-artifacts';

/** Matches the 0.12 `sleepAfter: '1h'` in worker-cf-sandbox.ts. */
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
/** The 0.12 `"standard"` instance type, renamed upstream. */
const INSTANCE_TYPE = 'standard-1';
const WORKSPACE = '/workspace';
const PROCESS_ROOT = '/tmp/push-procs';
const BACKUP_PREFIX = 'backups/';
/** 0.12's restore margin: a backup expiring within this window is refused. */
const BACKUP_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_BACKUP_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * Environment every command gets. `exec` in 1.0 inherits only PATH from the
 * container, and the image's ENV lines never reach commands.
 */
const BASE_ENV: Record<string, string> = {
  HOME: '/root',
  USER: 'root',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds; the command is killed past it (0.12 semantics). */
  timeout?: number;
}

export interface SandboxExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxProcessInfo {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode?: number;
  startTime?: Date;
  endTime?: Date;
}

/** What createBackup returns and descriptors store; `dir` may be overridden on restore. */
export type SandboxBackupHandle =
  | (DirectoryBackupRecord & { expiresAt?: string })
  | ArtifactBackupHandle;

export interface CreateBackupOptions {
  dir: string;
  name?: string;
  /** Seconds the backup stays restorable. */
  ttl?: number;
  gitignore?: boolean;
  /** 0.12 `excludes`: matched at any depth. */
  excludes?: string[];
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@');
}

const decoder = new TextDecoder();

/**
 * The method set worker-cf-sandbox.ts calls on a sandbox stub. The class
 * implements it, and the handler types its `getByName()` stub with it, so the
 * two can't drift. (A typed `DurableObjectStub<Sandbox>` needs the runtime's
 * RPC brand, which the app tsconfig deliberately doesn't load.)
 */
export interface SandboxFacade {
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(
    path: string,
  ): Promise<{ entries: Array<{ name: string; type: string; isDirectory: boolean }> }>;
  gitCheckout(
    repoUrl: string,
    options?: { branch?: string; targetDir?: string; depth?: number; artifactFs?: boolean },
  ): Promise<void>;
  startProcess(
    command: string,
    options?: SandboxExecOptions & { autoCleanup?: boolean },
  ): Promise<SandboxProcessInfo>;
  getProcess(id: string): Promise<SandboxProcessInfo | null>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  killProcess(id: string, signal?: string | number): Promise<void>;
  createBackup(options: CreateBackupOptions): Promise<SandboxBackupHandle>;
  restoreBackup(
    handle: SandboxBackupHandle,
  ): Promise<{ success: boolean; dir: string; id: string }>;
  destroy(): Promise<void>;
}

export class Sandbox extends DurableObject<Env> implements SandboxFacade {
  #starting: Promise<void> | null = null;
  #files: Files | null = null;
  #backups: DirectoryBackup | null = null;
  #artifactSource: string | null | undefined;
  #artifactLeaseRefreshedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout doesn't survive a Durable Object restart; put it
    // back if the container outlived the previous instance.
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(async () => {
        await ctx.container?.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      });
    }
  }

  get #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured for the Sandbox class');
    return container;
  }

  get #fileApi(): Files {
    this.#files ??= new Files(this.#container);
    return this.#files;
  }

  get #backupApi(): DirectoryBackup {
    const gateway = (
      this.ctx.exports as unknown as { DirectoryBackupGateway?: DirectoryBackupGatewayBinding }
    ).DirectoryBackupGateway;
    if (!gateway) throw new Error('DirectoryBackupGateway is not exported from the Worker');
    this.#backups ??= new DirectoryBackup(this.#container, gateway, {
      binding: 'BACKUP_BUCKET',
      prefix: BACKUP_PREFIX,
    });
    return this.#backups;
  }

  /** Start the container once; concurrent callers share the same start. */
  async #ensureRunning(): Promise<void> {
    await this.#touchArtifactLease();
    if (this.#container.running) return;
    this.#starting ??= (async () => {
      try {
        const image = this.#container.images.sandbox;
        if (!image) throw new Error('No "sandbox" image is configured for the container');
        this.#container.start({
          image,
          enableInternet: true,
          instance: INSTANCE_TYPE,
          env: BASE_ENV,
        });
        await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      } catch (error) {
        await this.#container.destroy().catch(() => {});
        throw error;
      }
    })().finally(() => {
      this.#starting = null;
    });
    await this.#starting;
  }

  async #touchArtifactLease(): Promise<void> {
    if (this.env.CF_ARTIFACTS && this.env.SANDBOX_TOKENS) {
      if (this.#artifactSource === undefined) {
        this.#artifactSource = (await this.ctx.storage.get<string>('artifact-source')) ?? null;
      }
      if (this.#artifactSource && Date.now() - this.#artifactLeaseRefreshedAt > 300_000) {
        await this.env.SANDBOX_TOKENS.put(`artifact-lease:${this.#artifactSource}`, 'active', {
          expirationTtl: 172800,
        });
        this.#artifactLeaseRefreshedAt = Date.now();
      }
    }
  }

  async #run(argv: string[], options: SandboxExecOptions = {}) {
    await this.#ensureRunning();
    // Built untyped and cast once: the DOM lib's AbortSignal and the Workers
    // types' are distinct declarations of the same runtime object.
    const execOptions = {
      cwd: options.cwd ?? WORKSPACE,
      env: { ...BASE_ENV, ...options.env },
      ...(options.timeout !== undefined && options.timeout > 0
        ? { signal: AbortSignal.timeout(options.timeout) }
        : {}),
    } as unknown as Parameters<Container['exec']>[1];
    const process = await this.#container.exec(argv, execOptions);
    const output = await process.output();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** 0.12 `exec(command, options)`: a shell string, never throws on a non-zero exit. */
  async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    try {
      const result = await this.#run(['bash', '-c', command], options);
      return { success: result.exitCode === 0, ...result };
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
        // 0.12 reported a killed-by-timeout command as exit 124, like GNU timeout.
        return { success: false, exitCode: 124, stdout: '', stderr: 'Command timed out' };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async readFile(path: string): Promise<{ content: string }> {
    await this.#ensureRunning();
    const response = await this.#fileApi.readFile(path, { cwd: WORKSPACE });
    return { content: await response.text() };
  }

  /** Creates parent directories and writes atomically, as 0.12 behaved. */
  async writeFile(path: string, content: string): Promise<void> {
    await this.#ensureRunning();
    const absolute = path.startsWith('/') ? path : `${WORKSPACE}/${path}`;
    const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    await this.#fileApi.mkdir(parent, { recursive: true });
    const temp = `${absolute}.push-tmp-${crypto.randomUUID()}`;
    await this.#fileApi.writeFile(temp, content);
    await this.#fileApi.rename(temp, absolute);
  }

  async deleteFile(path: string): Promise<void> {
    await this.#ensureRunning();
    await this.#fileApi.remove(path, { cwd: WORKSPACE });
  }

  /** Entries without dotfiles, as 0.12's default listing returned them. */
  async listFiles(
    path: string,
  ): Promise<{ entries: Array<{ name: string; type: string; isDirectory: boolean }> }> {
    await this.#ensureRunning();
    const entries = await this.#fileApi.readDirectory(path, { cwd: WORKSPACE });
    return {
      entries: entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          type: entry.type,
          isDirectory: entry.type === 'directory',
        })),
    };
  }

  // -------------------------------------------------------------------------
  // Git
  // -------------------------------------------------------------------------

  /** 0.12 `gitCheckout`: throws git's own message, so clone-failure classifiers keep matching. */
  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string; depth?: number; artifactFs?: boolean } = {},
  ): Promise<void> {
    if (
      options.artifactFs &&
      this.env.CF_ARTIFACTS &&
      this.env.SANDBOX_TOKENS &&
      this.env.PUSH_ARTIFACT_FS === '1' &&
      (options.targetDir ?? WORKSPACE) === WORKSPACE &&
      options.branch
    ) {
      const source = new URL(repoUrl);
      // Cloudflare import currently supports public HTTPS sources only. Never
      // send a user's GitHub credential to the import service.
      source.username = '';
      source.password = '';
      if (source.hostname === 'github.com') {
        const name = artifactRepoName(ARTIFACT_SOURCE_PREFIX, Date.now() + 24 * 60 * 60 * 1000);
        try {
          const created = await this.env.CF_ARTIFACTS.import({
            source: { url: source.toString(), branch: options.branch, depth: 1 },
            target: { name, opts: { readOnly: true } },
          });
          using sourceRepo = await waitForArtifactRepo(this.env.CF_ARTIFACTS, name);
          // The imported public source is read-only. Bound its token to the
          // service maximum; source deletion revokes it with the repository.
          const readToken = await sourceRepo.createToken('read', 31_536_000);
          await sourceRepo.revokeToken(created.token);
          const mounted = await this.#run(
            ['bash', '/usr/local/bin/push-artifactfs', options.branch, source.toString()],
            {
              cwd: '/',
              timeout: 90_000,
              env: {
                PUSH_ARTIFACT_REMOTE: authenticatedArtifactRemote(
                  created.remote,
                  readToken.plaintext,
                ),
              },
            },
          );
          if (mounted.exitCode !== 0) throw new Error('ArtifactFS mount failed');
          await this.env.SANDBOX_TOKENS.put(`artifact-lease:${name}`, 'active', {
            expirationTtl: 172800,
          });
          await this.ctx.storage.put('artifact-source', name);
          this.#artifactSource = name;
          this.#artifactLeaseRefreshedAt = Date.now();
          console.log(JSON.stringify({ event: 'cf_artifactfs_mounted', source: name }));
          return;
        } catch (error) {
          // A failed mount must be gone before cloning into the target.
          const cleaned = await this.#run(['bash', '/usr/local/bin/push-artifactfs', '--cleanup'], {
            cwd: '/',
          });
          if (cleaned.exitCode !== 0)
            throw new Error('ArtifactFS cleanup failed; refusing to overwrite workspace', {
              cause: error,
            });
          await this.env.CF_ARTIFACTS.delete(name).catch(() => {});
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'cf_artifactfs_fallback',
              reason: artifactFailureReason(error),
            }),
          );
        }
      }
    }
    const args = ['git', 'clone'];
    if (options.depth) args.push('--depth', String(options.depth));
    if (options.branch) args.push('--branch', options.branch);
    args.push('--', repoUrl, options.targetDir ?? WORKSPACE);
    const result = await this.#run(args, { cwd: '/' });
    if (result.exitCode !== 0) {
      throw new Error(
        redactCredentials(result.stderr.trim() || `git clone exited ${result.exitCode}`),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Background processes (exec-start / exec-status / exec-logs / exec-kill)
  // -------------------------------------------------------------------------

  async startProcess(
    command: string,
    options: SandboxExecOptions & { autoCleanup?: boolean } = {},
  ): Promise<SandboxProcessInfo> {
    const id = crypto.randomUUID();
    const dir = `${PROCESS_ROOT}/${id}`;
    const seconds = options.timeout && options.timeout > 0 ? Math.ceil(options.timeout / 1000) : 0;
    // The command gets its own bash, so an `exit` in it can't skip the exit-code
    // and end-time bookkeeping that follows.
    const body = `${seconds > 0 ? `timeout -k 5 ${seconds} ` : ''}bash -c ${shellQuote(command)}`;
    // setsid gives the process its own group, so a kill reaches its children.
    // One step per line under `set -e`: the backgrounding `&` must end its own
    // line (joining with `&&` made `& &&`, a syntax error), and a failed mkdir
    // still stops the launch.
    const launcher = [
      'set -e',
      `mkdir -p ${shellQuote(dir)}`,
      `date +%s%3N > ${shellQuote(`${dir}/start`)}`,
      `setsid bash -c ${shellQuote(`${body}; echo $? > ${dir}/exit.tmp && mv ${dir}/exit.tmp ${dir}/exit && date +%s%3N > ${dir}/end`)} ` +
        `> ${shellQuote(`${dir}/stdout`)} 2> ${shellQuote(`${dir}/stderr`)} < /dev/null &`,
      `echo $! > ${shellQuote(`${dir}/pid`)}`,
    ].join('\n');
    const started = await this.#run(['bash', '-c', launcher], {
      cwd: options.cwd,
      env: options.env,
    });
    if (started.exitCode !== 0) {
      throw new Error(
        `startProcess failed: ${started.stderr.trim() || `exit ${started.exitCode}`}`,
      );
    }
    return { id, status: 'running', startTime: new Date() };
  }

  async getProcess(id: string): Promise<SandboxProcessInfo | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const dir = `${PROCESS_ROOT}/${id}`;
    const probe = await this.#run([
      'bash',
      '-c',
      `[ -d ${dir} ] || { echo missing; exit 0; }; ` +
        `echo "start=$(cat ${dir}/start 2>/dev/null)"; echo "end=$(cat ${dir}/end 2>/dev/null)"; ` +
        `echo "exit=$(cat ${dir}/exit 2>/dev/null)"; echo "killed=$([ -f ${dir}/killed ] && echo 1)"; ` +
        // PID 1 (`sleep infinity`) never reaps, so a dead leader lingers as a
        // zombie that `kill -0` still finds. Count only a non-zombie as alive.
        `pid=$(cat ${dir}/pid 2>/dev/null); echo "alive=$([ -n "$pid" ] && ps -o stat= -p "$pid" 2>/dev/null | grep -q '^[^Z]' && echo 1)"`,
    ]);
    if (probe.stdout.trim() === 'missing') return null;
    const field = (key: string) =>
      /^(\w+)=(.*)$/m.exec(
        probe.stdout.split('\n').find((l) => l.startsWith(`${key}=`)) ?? '',
      )?.[2] ?? '';
    const startMs = Number(field('start'));
    const endMs = Number(field('end'));
    const exitRaw = field('exit');
    const base = {
      id,
      ...(startMs ? { startTime: new Date(startMs) } : {}),
      ...(endMs ? { endTime: new Date(endMs) } : {}),
    };
    if (field('killed') === '1')
      return { ...base, status: 'killed', ...(exitRaw ? { exitCode: Number(exitRaw) } : {}) };
    if (exitRaw !== '') {
      const exitCode = Number(exitRaw);
      return { ...base, status: exitCode === 0 ? 'completed' : 'failed', exitCode };
    }
    // No exit file and the group leader is gone: it died without recording one.
    return field('alive') === '1' ? { ...base, status: 'running' } : { ...base, status: 'failed' };
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Process ${id} not found`);
    const dir = `${PROCESS_ROOT}/${id}`;
    const [stdout, stderr] = await Promise.all([
      this.#run(['cat', `${dir}/stdout`]),
      this.#run(['cat', `${dir}/stderr`]),
    ]);
    if (stdout.exitCode !== 0 && stderr.exitCode !== 0) throw new Error(`Process ${id} not found`);
    return { stdout: stdout.stdout, stderr: stderr.stdout };
  }

  async killProcess(id: string, signal: string | number = 'TERM'): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Process ${id} not found`);
    const dir = `${PROCESS_ROOT}/${id}`;
    const sig =
      String(signal)
        .replace(/^SIG/i, '')
        .replace(/[^A-Za-z0-9]/g, '') || 'TERM';
    const result = await this.#run([
      'bash',
      '-c',
      `pid=$(cat ${dir}/pid 2>/dev/null) || exit 3; touch ${dir}/killed; kill -${sig} -- "-$pid" 2>/dev/null || kill -${sig} "$pid"`,
    ]);
    if (result.exitCode === 3) throw new Error(`Process ${id} not found`);
  }

  // -------------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------------

  async createBackup(options: CreateBackupOptions): Promise<SandboxBackupHandle> {
    if (!options.dir.startsWith('/'))
      throw codedError('INVALID_BACKUP_CONFIG', `dir must be absolute: ${options.dir}`);
    await this.#ensureRunning();
    if (
      this.env.CF_ARTIFACTS &&
      this.env.PUSH_ARTIFACT_CHECKPOINTS === '1' &&
      options.dir === WORKSPACE
    ) {
      try {
        const handle = await this.#createArtifactBackup(options);
        console.log(JSON.stringify({ event: 'cf_artifact_checkpoint_captured', id: handle.id }));
        return handle;
      } catch (error) {
        const reason = artifactFailureReason(error);
        const mounted = await this.#run(['mountpoint', '-q', WORKSPACE]);
        if (mounted.exitCode === 0) {
          console.log(
            JSON.stringify({ level: 'error', event: 'cf_artifact_checkpoint_failed', reason }),
          );
          throw codedError('BACKUP_FAILED', 'Artifacts checkpoint failed for mounted workspace');
        }
        console.log(
          JSON.stringify({ level: 'warn', event: 'cf_artifact_checkpoint_fallback', reason }),
        );
      }
    }
    const record = await this.#backupApi.backup({
      dir: options.dir,
      ...(options.name ? { name: options.name } : {}),
      ...(options.gitignore ? { gitignore: true } : {}),
      ...(options.excludes?.length ? { exclude: options.excludes.map((p) => `**/${p}`) } : {}),
    });
    const ttl = options.ttl ?? DEFAULT_BACKUP_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await this.#bucket().put(
      `${BACKUP_PREFIX}${record.id}.meta.json`,
      JSON.stringify({ expiresAt }),
    );
    return { ...record, expiresAt };
  }

  /** Restores into `handle.dir`. Returns 0.12's `{ success, dir, id }`. */
  async restoreBackup(
    handle: SandboxBackupHandle,
  ): Promise<{ success: boolean; dir: string; id: string }> {
    if (!handle?.id || !handle.dir?.startsWith('/')) {
      throw codedError('INVALID_BACKUP_CONFIG', 'backup handle needs an id and an absolute dir');
    }
    if (handle.format === 'push-artifacts-v1') return this.#restoreArtifactBackup(handle);
    const legacyId = handle.id;
    if (!handle.format) {
      // A descriptor written by 0.12 (SquashFS). Not converted: it would have
      // expired within seven days of the cutover anyway, and BACKUP_EXPIRED
      // routes callers to the same "start fresh" path an aged-out one takes.
      console.log(
        JSON.stringify({ level: 'warn', event: 'cf_legacy_backup_refused', backup_id: legacyId }),
      );
      throw codedError(
        'BACKUP_EXPIRED',
        `backup ${legacyId} was made by Sandbox SDK 0.12 and is not restorable after the 1.0 upgrade`,
      );
    }
    await this.#ensureRunning();
    const meta = await this.#bucket().get(`${BACKUP_PREFIX}${handle.id}.meta.json`);
    if (!meta) throw codedError('BACKUP_NOT_FOUND', `backup ${handle.id} has no metadata`);
    const { expiresAt } = (await meta.json()) as { expiresAt?: string };
    if (expiresAt && Date.parse(expiresAt) - BACKUP_EXPIRY_MARGIN_MS <= Date.now()) {
      throw codedError('BACKUP_EXPIRED', `backup ${handle.id} expired at ${expiresAt}`);
    }
    try {
      await this.#backupApi.restore(handle as DirectoryBackupRecord, { dir: handle.dir });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      throw codedError(
        code === 'BACKUP_NOT_FOUND' ? 'BACKUP_NOT_FOUND' : 'BACKUP_RESTORE_FAILED',
        String((error as Error)?.message ?? error),
      );
    }
    return { success: true, dir: handle.dir, id: handle.id };
  }

  async #createArtifactBackup(options: CreateBackupOptions): Promise<ArtifactBackupHandle> {
    const artifacts = this.env.CF_ARTIFACTS!;
    const expiresAt = Date.now() + (options.ttl ?? DEFAULT_BACKUP_TTL_SECONDS) * 1000;
    const id = artifactRepoName(ARTIFACT_REPO_PREFIX, expiresAt);
    const stage = `/tmp/${id}`;
    try {
      const captured = await this.#run(
        ['timeout', '-k', '5', '90', 'push-artifacts-checkpoint', 'capture', options.dir, stage],
        { timeout: 90_000 },
      );
      const commit = captured.stdout.trim();
      if (captured.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit))
        throw new Error('Checkpoint capture failed');
      const created = await artifacts.create(id, { setDefaultBranch: 'checkpoint' });
      using repo = (await artifacts.get(id)) as ArtifactsRepo & Disposable;
      const token = await repo.createToken('write', 300);
      await repo.revokeToken(created.token);
      try {
        const pushed = await this.#run(
          [
            'bash',
            '-c',
            'timeout -k 5 90 git -c core.hooksPath=/dev/null push "$PUSH_ARTIFACT_REMOTE" HEAD:refs/heads/checkpoint',
          ],
          {
            cwd: stage,
            timeout: 90_000,
            env: {
              PUSH_ARTIFACT_REMOTE: authenticatedArtifactRemote(created.remote, token.plaintext),
            },
          },
        );
        if (pushed.exitCode !== 0) throw new Error('Checkpoint upload failed');
      } finally {
        await repo.revokeToken(token.plaintext);
      }
      return {
        format: 'push-artifacts-v1',
        id,
        dir: options.dir,
        commit,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      await artifacts.delete(id).catch(() => {});
      throw error;
    } finally {
      await this.#run(['rm', '-rf', '--', stage], { cwd: '/' });
    }
  }

  async #restoreArtifactBackup(handle: ArtifactBackupHandle) {
    validateArtifactBackup(handle);
    if (!this.env.CF_ARTIFACTS)
      throw codedError('INVALID_BACKUP_CONFIG', 'CF_ARTIFACTS binding is missing');
    const stage = `/tmp/push-artifact-download-${crypto.randomUUID()}`;
    using repo = (await this.env.CF_ARTIFACTS.get(handle.id)) as ArtifactsRepo & Disposable;
    const info = await repo.info();
    const token = await repo.createToken('read', 300);
    try {
      const result = await this.#run(
        [
          'bash',
          '-c',
          'timeout -k 5 60 git clone --no-checkout --depth 1 --branch checkpoint -- "$PUSH_ARTIFACT_REMOTE" "$1" >/dev/null 2>&1 && test "$(git -C "$1" rev-parse HEAD)" = "$2" && timeout -k 5 30 push-artifacts-checkpoint restore "$1" "$3"',
          'restore',
          stage,
          handle.commit,
          handle.dir,
        ],
        {
          cwd: '/',
          timeout: 90_000,
          env: { PUSH_ARTIFACT_REMOTE: authenticatedArtifactRemote(info.remote, token.plaintext) },
        },
      );
      if (result.exitCode !== 0)
        throw codedError('BACKUP_RESTORE_FAILED', 'Artifacts checkpoint restore failed');
      return { success: true, id: handle.id, dir: handle.dir };
    } finally {
      await repo.revokeToken(token.plaintext);
      await this.#run(['rm', '-rf', '--', stage], { cwd: '/' });
    }
  }

  #bucket(): R2Bucket {
    if (!this.env.BACKUP_BUCKET)
      throw codedError('INVALID_BACKUP_CONFIG', 'BACKUP_BUCKET binding is missing');
    return this.env.BACKUP_BUCKET;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async destroy(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    if (this.env.CF_ARTIFACTS) {
      const source =
        this.#artifactSource ?? (await this.ctx.storage.get<string>('artifact-source'));
      if (source) {
        await this.env.CF_ARTIFACTS.delete(source);
        await this.env.SANDBOX_TOKENS?.delete(`artifact-lease:${source}`);
        await this.ctx.storage.delete('artifact-source');
        this.#artifactSource = null;
      }
    }
  }
}
