/**
 * Shared `/checkpoint` subcommand dispatcher.
 *
 * The REPL (`cli/cli.ts`) and TUI (`cli/tui.ts`) used to carry near-identical
 * handlers that differed only in their output sinks. This module hosts the
 * dispatch + formatting logic; surfaces supply a `CheckpointRenderer` that
 * knows how to print to stdout / paint into the transcript / etc.
 *
 * Renderer contract:
 *   - `status`  — multi-line informational text. No prefix added by the
 *                 dispatcher; the renderer can choose to embellish.
 *   - `warning` — usage hint or unknown subcommand.
 *   - `error`   — failure message. Dispatcher emits just the reason; the
 *                 renderer is responsible for any "checkpoint:" prefix
 *                 (REPL renders via `fmt.error`; TUI prepends in the
 *                 transcript entry).
 *   - `bold`    — wrap a single token for emphasis (e.g. a checkpoint
 *                 name in a sentence). REPL maps to ANSI; TUI maps to
 *                 identity (the transcript renderer strips styling).
 *   - `dim`     — same idea for de-emphasis.
 *   - `code`    — wrap a token formatted as a command/code (e.g.
 *                 `push resume <id>`). REPL maps to ANSI bold; TUI
 *                 maps to backtick-wrapping so commands stay visually
 *                 distinct in the transcript even without styling.
 *                 Distinct from `bold` so we don't backtick-wrap names
 *                 that are merely emphasized.
 *
 * The dispatcher swallows store errors and routes them through `error`. It
 * never throws — slash-command handlers are always best-effort.
 */
import { formatRelativeTime } from '../lib/time-utils.js';
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  loadCheckpoint,
} from './checkpoint-store.js';

export interface CheckpointRenderer {
  status: (text: string) => void;
  warning: (text: string) => void;
  error: (text: string) => void;
  bold: (text: string) => string;
  dim: (text: string) => string;
  code: (text: string) => string;
}

export interface CheckpointCommandContext {
  workspaceRoot: string;
  sessionId: string;
  messages: readonly unknown[];
  provider?: string | null;
  model?: string | null;
}

const HELP_TEXT = [
  'Usage:',
  '  /checkpoint create [name]    Snapshot conversation + changed files',
  '  /checkpoint list              List saved checkpoints',
  '  /checkpoint load <name>       Preview a restore',
  '  /checkpoint load <name> --force   Restore files (overwrites!)',
  '  /checkpoint delete <name>     Remove a checkpoint',
].join('\n');

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runCheckpointCommand(
  rawArg: string | null | undefined,
  ctx: CheckpointCommandContext,
  render: CheckpointRenderer,
): Promise<void> {
  const arg = String(rawArg || '').trim();
  if (!arg) {
    render.status(HELP_TEXT);
    return;
  }
  const parts = arg.split(/\s+/);
  const op = parts[0];

  if (op === 'create') {
    try {
      const meta = await createCheckpoint({
        workspaceRoot: ctx.workspaceRoot,
        name: parts[1],
        sessionId: ctx.sessionId,
        messages: ctx.messages,
        provider: ctx.provider,
        model: ctx.model,
      });
      const skipNote = meta.skippedFiles?.length
        ? ` (${meta.skippedFiles.length} skipped — too large or unreadable)`
        : '';
      render.status(
        `Saved checkpoint ${render.bold(meta.name)}: ${meta.fileCount} file(s), ${meta.messageCount} message(s)${skipNote}.`,
      );
    } catch (err) {
      render.error(describeError(err));
    }
    return;
  }

  if (op === 'list') {
    const items = await listCheckpoints(ctx.workspaceRoot);
    if (items.length === 0) {
      render.status(`No checkpoints. Create one with ${render.code('/checkpoint create [name]')}.`);
      return;
    }
    const lines = items.map((m) => {
      const branch = m.branch ? ` ${render.dim(`@${m.branch}`)}` : '';
      return `  ${render.bold(m.name)}  ${render.dim(formatRelativeTime(m.createdAt))}  ${m.fileCount} file(s), ${m.messageCount} msg${branch}`;
    });
    render.status(lines.join('\n'));
    return;
  }

  if (op === 'load') {
    const name = parts[1];
    if (!name) {
      render.warning('Usage: /checkpoint load <name> [--force]');
      return;
    }
    const force = parts.includes('--force');
    const items = await listCheckpoints(ctx.workspaceRoot);
    const meta = items.find((m) => m.name === name);
    if (!meta) {
      render.error(`no checkpoint named "${name}".`);
      return;
    }
    if (!force) {
      // Preview only — destructive action requires --force.
      const head = meta.files
        .slice(0, 10)
        .map((f) => `  - ${f}`)
        .join('\n');
      const tail = meta.files.length > 10 ? `\n  ... and ${meta.files.length - 10} more` : '';
      const resumeHint = render.code(`push resume ${meta.sessionId || '<session>'}`);
      render.status(
        `Would restore ${meta.fileCount} file(s) from ${render.bold(meta.name)} (${formatRelativeTime(meta.createdAt)}).\n${head}${tail}\n\nThis will OVERWRITE matching files in your working tree. Re-run with --force to apply.\nConversation rollback is not in-process: after restoring files, /exit and run ${resumeHint} to restore the conversation.`,
      );
      return;
    }
    try {
      const result = await loadCheckpoint(ctx.workspaceRoot, name);
      const skipNote = result.skippedFiles.length ? ` (${result.skippedFiles.length} skipped)` : '';
      const resumeHint = render.code(`push resume ${result.meta.sessionId || '<session>'}`);
      render.status(
        `Restored ${result.restoredFiles.length} file(s) from ${render.bold(name)}${skipNote}.\nConversation is unchanged. To restore the conversation: /exit, then ${resumeHint}.`,
      );
    } catch (err) {
      render.error(describeError(err));
    }
    return;
  }

  if (op === 'delete') {
    const name = parts[1];
    if (!name) {
      render.warning('Usage: /checkpoint delete <name>');
      return;
    }
    try {
      await deleteCheckpoint(ctx.workspaceRoot, name);
      render.status(`Deleted checkpoint ${render.bold(name)}.`);
    } catch (err) {
      render.error(describeError(err));
    }
    return;
  }

  render.warning(`Unknown subcommand "${op}". Type /checkpoint for help.`);
}
