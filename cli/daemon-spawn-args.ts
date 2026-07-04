/**
 * daemon-spawn-args.ts — Runtime-aware argv for spawning pushd.
 *
 * The daemon self-heal (stale-build drain → respawn), TUI autostart, and
 * `daemon start` all re-spawn pushd from `process.execPath` with the current
 * entry file. Which loader flags that argv needs depends on the RUNTIME, not
 * the file extension:
 *
 *   - Under Node, a `.ts`/`.mts` entry needs the tsx ESM loader
 *     (`--import tsx`) — plain `node pushd.ts` dies with
 *     "Unknown file extension .ts". `.js`/`.mjs` run directly.
 *   - Under Bun, TypeScript runs natively, so NO loader is wanted — and
 *     passing `--import tsx` is not merely redundant, it's fatal: Bun's
 *     resolver can't load tsx's `./cjs/index.cjs` and the child dies with
 *     `Cannot find module './cjs/index.cjs' from ''` before pushd's main()
 *     ever runs. That was the silent self-heal respawn failure this module
 *     fixes (a stale-build drain under `dev:cli:bun` could never respawn).
 *
 * Under Bun we also pass `--no-env-file`, mirroring the `dev:cli:bun` script
 * and the compiled-binary flags in `docs/decisions/Bun Runtime Adoption.md`:
 * without it a Bun child auto-loads `.env`/`.env.local` from cwd into
 * process.env ahead of the env scrub — the exact injection vector the doc's
 * Phase 0 closes for the distributed binary. Keep the daemon symmetric.
 *
 * Pure and side-effect-free (except `isBunRuntime`, which reads
 * `process.versions`) so the unit tests pin every branch without spawning a
 * process — same shape as `tui-daemon-errors.ts`.
 */

import { fileURLToPath } from 'node:url';

export type PushdEntryCandidate = {
  ext: string | null;
  path: string | null;
};

export type PushdSpawnPlan =
  | {
      mode: 'script';
      args: string[];
      entry: string;
    }
  | {
      mode: 'self-exec';
      args: string[];
      pushdPathChecked: string | null;
    };

/** True when the spawning process is itself running under Bun. */
export function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.bun);
}

/**
 * Loader-arg prefix that must sit BEFORE the pushd entry path in the spawn
 * argv, given the running interpreter and the entry file extension.
 *
 * @param opts.underBun whether the spawning process runs under Bun
 * @param opts.ext      entry extension: 'ts' | 'mts' | 'js' | 'mjs' | null
 * @returns argv fragment to splice ahead of the entry path
 */
export function pushdLoaderArgs(opts: { underBun: boolean; ext: string | null }): string[] {
  if (opts.underBun) {
    // Native TS; no tsx loader. `--no-env-file` keeps the daemon's env model
    // aligned with the compiled binary (no cwd `.env` autoload).
    return ['--no-env-file'];
  }
  // Node: TypeScript entries need the tsx loader; `.js`/`.mjs` run directly.
  return opts.ext === 'ts' || opts.ext === 'mts' ? ['--import', 'tsx'] : [];
}

export function resolvePushdEntryCandidate(importMetaUrl: string): PushdEntryCandidate {
  const extMatch = importMetaUrl.match(/\.(m?[jt]s)$/);
  if (!extMatch) {
    return { ext: null, path: null };
  }
  const ext = extMatch[1];
  return {
    ext,
    // Decodes percent-escaped paths and preserves Windows drive semantics.
    path: fileURLToPath(new URL(`./pushd.${ext}`, importMetaUrl)),
  };
}

export function pushdSpawnPlan(opts: {
  underBun: boolean;
  ext: string | null;
  path: string | null;
  pathExists: boolean;
}): PushdSpawnPlan {
  if (opts.ext && opts.path && opts.pathExists) {
    return {
      mode: 'script',
      args: [...pushdLoaderArgs({ underBun: opts.underBun, ext: opts.ext }), opts.path],
      entry: opts.path,
    };
  }

  return {
    mode: 'self-exec',
    args: ['daemon', '__run'],
    pushdPathChecked: opts.path,
  };
}
