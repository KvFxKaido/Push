/**
 * Host-enforced containment for model-invoked subprocesses.
 *
 * `host` preserves the legacy direct-shell path. `docker` preserves the
 * existing `PUSH_LOCAL_SANDBOX=true` container path. `native` is the first
 * local OS-enforced backend: on Linux/WSL it runs the command under
 * Bubblewrap with a read-only host view, a writable workspace + tmpfs, host
 * runtime sockets under `/run` masked, and no network namespace by default.
 *
 * This module deliberately owns only subprocess containment. Built-in file
 * tools remain inside the workspace through `ensureInsideWorkspace`; moving
 * those operations behind an OS broker is a later phase of the host-
 * containment decision.
 */

import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import type { DaemonSandboxBackend } from '../lib/daemon-runtime-settings.js';
import {
  resolveCommandShell,
  runCommandInResolvedShell,
  spawnCommandInResolvedShell,
} from './shell.js';

const execFileAsync = promisify(execFile);

export type ExecSandboxBackend = DaemonSandboxBackend;

export interface ExecSandboxPlan {
  backend: Exclude<ExecSandboxBackend, 'host'>;
  bin: string;
  args: string[];
  cwd: string;
}

export interface ExecSandboxOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function normalizedBoolean(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

/**
 * Preserve the old boolean contract: `true` means Docker and `false` means
 * direct host execution. Named values make the new backend explicit.
 */
export function resolveExecSandboxBackend(
  raw: string | boolean | undefined = process.env.PUSH_LOCAL_SANDBOX,
): ExecSandboxBackend {
  if (typeof raw === 'boolean') return raw ? 'docker' : 'host';
  if (raw === undefined || raw.trim() === '') return 'host';

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'native' || normalized === 'bubblewrap' || normalized === 'bwrap') {
    return 'native';
  }
  if (normalized === 'docker') return 'docker';
  if (normalized === 'host' || normalized === 'none') return 'host';
  const booleanValue = normalizedBoolean(normalized);
  if (booleanValue !== null) return booleanValue ? 'docker' : 'host';

  throw new Error(
    `Invalid PUSH_LOCAL_SANDBOX value ${JSON.stringify(raw)}. Use host, docker, native, true, or false.`,
  );
}

function pathCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  if (path.isAbsolute(binary)) return [binary];
  return (env.PATH || process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, binary));
}

async function resolveBubblewrapBinary(env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error(
      `Native exec sandbox is currently supported only on Linux/WSL; current platform is ${process.platform}.`,
    );
  }

  const configured = env.PUSH_BWRAP_PATH || process.env.PUSH_BWRAP_PATH || 'bwrap';
  for (const candidate of pathCandidates(configured, env)) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(
    'Native exec sandbox requires Bubblewrap (`bwrap`) on PATH. Install bubblewrap or choose --sandbox-backend docker|host.',
  );
}

function nativeNetworkAllowed(env: NodeJS.ProcessEnv): boolean {
  return (
    normalizedBoolean(
      env.PUSH_NATIVE_SANDBOX_NETWORK || process.env.PUSH_NATIVE_SANDBOX_NETWORK,
    ) === true
  );
}

export interface NativeSandboxArgsInput {
  command: string;
  workspaceRoot: string;
  cwd: string;
  shell: { bin: string; argsPrefix: string[]; commandMode: 'argv' | 'stdin' };
  networkAccess?: boolean;
  writableGitMetadataPaths?: string[];
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveGitFileTarget(contents: string, baseDir: string, label: string): string {
  const value = contents.trim();
  const target = label === '.git' ? value.match(/^gitdir:\s*(.+)$/i)?.[1] : value;
  if (!target) throw new Error(`Native exec sandbox could not parse linked-worktree ${label}.`);
  return path.resolve(baseDir, target);
}

async function resolveNativeGitMetadataPaths(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  // Do not let caller-provided Git routing variables redirect the host-side
  // discovery command. The fixed `-C` root is the only authority here.
  const gitEnv = { ...env };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  delete gitEnv.GIT_COMMON_DIR;

  let output: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        workspaceRoot,
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ],
      { env: gitEnv, encoding: 'utf8' },
    );
    output = String(stdout);
  } catch {
    return [];
  }

  const [rawTopLevel, rawGitDir, rawCommonDir] = output.split(/\r?\n/).filter(Boolean);
  if (!rawTopLevel || !rawGitDir || !rawCommonDir) {
    throw new Error('Native exec sandbox could not resolve Git metadata paths safely.');
  }

  const [topLevel, gitDir, commonDir] = await Promise.all([
    fs.realpath(rawTopLevel),
    fs.realpath(rawGitDir),
    fs.realpath(rawCommonDir),
  ]);
  if (!isInsidePath(topLevel, workspaceRoot)) {
    throw new Error(
      'Native exec sandbox refused Git metadata whose worktree does not contain the workspace.',
    );
  }
  const marker = path.join(topLevel, '.git');
  const markerStat = await fs.stat(marker);

  if (markerStat.isFile()) {
    // A linked worktree's writable metadata lives outside its checkout. Verify
    // both pointers before granting that external directory write access: the
    // workspace marker must name this gitdir, and the registered gitdir must
    // point back to the same marker. A command can edit the workspace marker,
    // but it cannot forge the read-only reciprocal pointer outside the sandbox.
    try {
      const markerTarget = await fs.realpath(
        resolveGitFileTarget(await fs.readFile(marker, 'utf8'), path.dirname(marker), '.git'),
      );
      const reciprocalTarget = await fs.realpath(
        resolveGitFileTarget(
          await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8'),
          gitDir,
          'gitdir',
        ),
      );
      const registeredCommonDir = await fs.realpath(
        resolveGitFileTarget(
          await fs.readFile(path.join(gitDir, 'commondir'), 'utf8'),
          gitDir,
          'commondir',
        ),
      );
      const realMarker = await fs.realpath(marker);
      if (
        markerTarget !== gitDir ||
        reciprocalTarget !== realMarker ||
        registeredCommonDir !== commonDir
      ) {
        throw new Error('pointer mismatch');
      }
    } catch {
      throw new Error('Native exec sandbox refused inconsistent linked-worktree metadata.');
    }
  } else if (!markerStat.isDirectory()) {
    throw new Error('Native exec sandbox refused an unsupported .git marker.');
  }

  const externalPaths = [...new Set([gitDir, commonDir])]
    .filter((candidate) => !isInsidePath(workspaceRoot, candidate))
    .sort((left, right) => left.length - right.length)
    .filter((candidate, index, paths) =>
      paths.slice(0, index).every((parent) => !isInsidePath(parent, candidate)),
    );

  for (const candidate of externalPaths) {
    if (candidate === path.parse(candidate).root || isInsidePath(candidate, workspaceRoot)) {
      throw new Error(
        `Native exec sandbox refused dangerously broad Git metadata path: ${candidate}`,
      );
    }
  }
  return externalPaths;
}

/** Exported as a pure builder so the security boundary has direct tests. */
export function buildNativeSandboxArgs(input: NativeSandboxArgsInput): string[] {
  if (input.shell.commandMode !== 'argv') {
    throw new Error('Native exec sandbox requires an argv-capable POSIX shell.');
  }

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const cwd = path.resolve(input.cwd);
  const relativeCwd = path.relative(workspaceRoot, cwd);
  if (
    relativeCwd === '..' ||
    relativeCwd.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCwd)
  ) {
    throw new Error(`Native exec sandbox cwd escapes workspace root: ${cwd}`);
  }

  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    ...(input.networkAccess ? [] : ['--unshare-net']),
    // Outside the workspace the host is readable but not writable. This
    // preserves compiler/runtime discovery while enforcing the mutation
    // boundary at the OS layer.
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    // Hide conventional host service sockets under /run (Docker, system
    // daemons) and give commands writable, disposable temp areas. Mount the
    // workspace after tmpfs so one rooted under /tmp or /var/tmp stays visible.
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/tmp',
    '--chmod',
    '1777',
    '/tmp',
    '--tmpfs',
    '/var/tmp',
    '--chmod',
    '1777',
    '/var/tmp',
    '--bind',
    workspaceRoot,
    workspaceRoot,
    ...(input.writableGitMetadataPaths || []).flatMap((metadataPath) => [
      '--bind',
      metadataPath,
      metadataPath,
    ]),
    '--chdir',
    cwd,
    input.shell.bin,
    ...input.shell.argsPrefix,
    input.command,
  ];
}

export async function createExecSandboxPlan(
  command: string,
  workspaceRoot: string,
  options: Pick<ExecSandboxOptions, 'cwd' | 'env'> & { keepStdinOpen?: boolean } = {},
): Promise<ExecSandboxPlan | null> {
  const backend = resolveExecSandboxBackend();
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const cwd = await fs.realpath(path.resolve(options.cwd || root));
  const env = options.env ?? process.env;

  if (backend === 'host') return null;
  if (backend === 'docker') {
    const relativeCwd = path.relative(root, cwd);
    if (
      relativeCwd === '..' ||
      relativeCwd.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCwd)
    ) {
      throw new Error(`Docker exec sandbox cwd escapes workspace root: ${cwd}`);
    }
    const containerCwd = relativeCwd ? path.posix.join('/workspace', relativeCwd) : '/workspace';
    return {
      backend,
      bin: 'docker',
      args: [
        'run',
        '--rm',
        ...(options.keepStdinOpen ? ['-i'] : []),
        '-v',
        `${root}:/workspace`,
        '-w',
        containerCwd,
        'push-sandbox',
        'bash',
        '-lc',
        command,
      ],
      cwd: root,
    };
  }

  if (root === path.parse(root).root) {
    throw new Error(
      'Native exec sandbox refuses to use the filesystem root as a writable workspace.',
    );
  }
  const [bwrap, shell, writableGitMetadataPaths] = await Promise.all([
    resolveBubblewrapBinary(env),
    resolveCommandShell(),
    resolveNativeGitMetadataPaths(root, env),
  ]);
  return {
    backend,
    bin: bwrap,
    args: buildNativeSandboxArgs({
      command,
      workspaceRoot: root,
      cwd,
      shell,
      networkAccess: nativeNetworkAllowed(env),
      writableGitMetadataPaths,
    }),
    cwd: root,
  };
}

export async function runCommandInExecSandbox(
  command: string,
  workspaceRoot: string,
  options: ExecSandboxOptions = {},
): Promise<{ stdout: string; stderr: string; backend: ExecSandboxBackend }> {
  const plan = await createExecSandboxPlan(command, workspaceRoot, options);
  if (!plan) {
    const { stdout, stderr } = await runCommandInResolvedShell(command, options);
    return { stdout: String(stdout), stderr: String(stderr), backend: 'host' };
  }

  const { stdout, stderr } = await execFileAsync(plan.bin, plan.args, {
    ...options,
    cwd: plan.cwd,
    encoding: 'utf8',
  });
  return { stdout: String(stdout), stderr: String(stderr), backend: plan.backend };
}

export async function spawnCommandInExecSandbox(
  command: string,
  workspaceRoot: string,
  options: SpawnOptions = {},
) {
  const plan = await createExecSandboxPlan(command, workspaceRoot, {
    cwd: typeof options.cwd === 'string' ? options.cwd : workspaceRoot,
    env: options.env,
    keepStdinOpen: true,
  });
  if (!plan) {
    const result = await spawnCommandInResolvedShell(command, options);
    return { ...result, backend: 'host' as const };
  }

  const child = spawn(plan.bin, plan.args, { ...options, cwd: plan.cwd });
  return { child, backend: plan.backend };
}
