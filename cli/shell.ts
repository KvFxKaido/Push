import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandShellPlan {
  bin: string;
  argsPrefix: string[];
  family: 'posix' | 'powershell' | 'cmd';
  commandMode: 'argv' | 'stdin';
}

function normalizeEnvValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function planForShellBin(bin: string, platform: string = process.platform): CommandShellPlan | null {
  const normalized = normalizeEnvValue(bin);
  if (!normalized) return null;

  const base = path.basename(normalized).toLowerCase();
  if (base === 'cmd' || base === 'cmd.exe') {
    return {
      bin: normalized,
      argsPrefix: ['/d', '/s', '/c'],
      family: 'cmd',
      commandMode: 'argv',
    };
  }
  if (base.includes('pwsh') || base.includes('powershell')) {
    return {
      bin: normalized,
      argsPrefix: ['-NoLogo', '-NoProfile', '-Command'],
      family: 'powershell',
      commandMode: 'argv',
    };
  }
  if (base === 'sh' || base === 'sh.exe' || base === 'dash' || base === 'dash.exe') {
    return {
      bin: normalized,
      argsPrefix: platform === 'win32' ? ['-s'] : ['-c'],
      family: 'posix',
      commandMode: platform === 'win32' ? 'stdin' : 'argv',
    };
  }
  return {
    bin: normalized,
    argsPrefix: platform === 'win32' ? ['-l', '-s'] : ['-lc'],
    family: 'posix',
    commandMode: platform === 'win32' ? 'stdin' : 'argv',
  };
}

export function getCommandShellCandidates(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandShellPlan[] {
  const candidates: CommandShellPlan[] = [];
  const seen = new Set<string>();

  const pushCandidate = (bin: string | undefined) => {
    const plan = planForShellBin(bin || '', platform);
    if (!plan) return;
    const key = `${plan.bin}\0${plan.commandMode}\0${plan.argsPrefix.join('\0')}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(plan);
  };

  pushCandidate(env.PUSH_SHELL);

  if (platform === 'win32') {
    const envShellPlan = planForShellBin(env.SHELL || '', platform);
    const systemRoot = normalizeEnvValue(env.SystemRoot);
    const programFiles = [
      normalizeEnvValue(env['ProgramW6432']),
      normalizeEnvValue(env['ProgramFiles']),
      normalizeEnvValue(env['ProgramFiles(x86)']),
    ].filter(Boolean);

    if (envShellPlan?.family === 'posix') {
      pushCandidate(envShellPlan.bin);
    }
    if (systemRoot) {
      pushCandidate(path.join(systemRoot, 'System32', 'bash.exe'));
    }
    for (const base of programFiles) {
      pushCandidate(path.join(base, 'Git', 'bin', 'bash.exe'));
      pushCandidate(path.join(base, 'Git', 'usr', 'bin', 'bash.exe'));
    }
    pushCandidate('bash');
    pushCandidate('sh');
    if (envShellPlan?.family && envShellPlan.family !== 'posix') {
      pushCandidate(envShellPlan.bin);
    }
    pushCandidate('pwsh');
    pushCandidate('powershell.exe');
    pushCandidate(env.ComSpec || 'cmd.exe');
    return candidates;
  }

  pushCandidate(env.SHELL);
  pushCandidate('/bin/bash');
  pushCandidate('bash');
  pushCandidate('/bin/sh');
  pushCandidate('sh');
  return candidates;
}

async function probeShell(plan: CommandShellPlan): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      plan.bin,
      plan.commandMode === 'stdin' ? plan.argsPrefix : [...plan.argsPrefix, 'exit 0'],
      {
        stdio: 'pipe',
        windowsHide: true,
      },
    );

    if (plan.commandMode === 'stdin') {
      child.stdin?.end('exit 0\n');
    }

    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') {
        finish(false);
        return;
      }
      finish(false);
    });

    child.once('spawn', () => {
      if (plan.commandMode === 'argv') {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
      finish(true);
    });
  });
}

function createShellExitError(message: string, stdout: string, stderr: string, code, signal) {
  const err = new Error(message) as NodeJS.ErrnoException & {
    stdout?: string;
    stderr?: string;
    signal?: string | null;
    killed?: boolean;
  };
  err.code = typeof code === 'number' ? code : 1;
  err.stdout = stdout;
  err.stderr = stderr;
  err.signal = signal;
  err.killed = signal !== null;
  return err;
}

function spawnShellCommand(
  shell: CommandShellPlan,
  command: string,
  options: Parameters<typeof spawn>[2] = {},
) {
  const child = spawn(
    shell.bin,
    shell.commandMode === 'stdin' ? shell.argsPrefix : [...shell.argsPrefix, command],
    {
      stdio: 'ignore',
      windowsHide: true,
      ...options,
    },
  );
  if (shell.commandMode === 'stdin') {
    child.stdin?.end(`${command}\n`);
  }
  return child;
}

let cachedShellKey = '';
let cachedShellPlan: CommandShellPlan | null = null;
let cachedShellPromise: Promise<CommandShellPlan> | null = null;

export async function resolveCommandShell(): Promise<CommandShellPlan> {
  const key = [
    process.platform,
    process.env.PUSH_SHELL || '',
    process.env.SHELL || '',
    process.env.ComSpec || '',
  ].join('\n');

  if (cachedShellPlan && cachedShellKey === key) return cachedShellPlan;
  if (cachedShellPromise && cachedShellKey === key) return cachedShellPromise;

  cachedShellKey = key;
  cachedShellPromise = (async () => {
    const candidates = getCommandShellCandidates();
    const tried: string[] = [];

    for (const candidate of candidates) {
      tried.push(candidate.bin);
      if (await probeShell(candidate)) {
        cachedShellPlan = candidate;
        cachedShellPromise = null;
        return candidate;
      }
    }

    cachedShellPlan = null;
    cachedShellPromise = null;
    throw new Error(
      `No usable shell found for command execution. Tried: ${tried.join(', ')}. Set PUSH_SHELL to override.`,
    );
  })();

  return cachedShellPromise;
}

export async function runCommandInResolvedShell(
  command: string,
  options: Parameters<typeof execFileAsync>[2] = {},
) {
  const shell = await resolveCommandShell();
  if (shell.commandMode === 'argv') {
    return execFileAsync(shell.bin, [...shell.argsPrefix, command], options);
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const spawnOptions = { ...options };
    const timeoutMs = typeof spawnOptions.timeout === 'number' ? spawnOptions.timeout : 0;
    const maxBuffer = typeof spawnOptions.maxBuffer === 'number' ? spawnOptions.maxBuffer : Infinity;
    const abortSignal = spawnOptions.signal;
    delete spawnOptions.timeout;
    delete spawnOptions.maxBuffer;
    delete spawnOptions.signal;

    const child = spawnShellCommand(shell, command, {
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr });
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      reject(err);
    };

    const enforceMaxBuffer = () => {
      if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') <= maxBuffer) {
        return;
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      finishReject(
        createShellExitError(
          `stdout maxBuffer length exceeded: ${maxBuffer}`,
          stdout,
          stderr,
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          null,
        ),
      );
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      finishReject(abortError);
    };

    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finishReject(createShellExitError(`Command failed: ${command}`, stdout, stderr, null, 'SIGTERM'));
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      enforceMaxBuffer();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      enforceMaxBuffer();
    });
    child.once('error', (err) => finishReject(err));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finishResolve();
        return;
      }
      finishReject(createShellExitError(`Command failed: ${command}`, stdout, stderr, code, signal));
    });
  });
}

export async function spawnCommandInResolvedShell(
  command: string,
  options: Parameters<typeof spawn>[2] = {},
) {
  const shell = await resolveCommandShell();
  const child = spawnShellCommand(shell, command, options);
  return { child, shell };
}
