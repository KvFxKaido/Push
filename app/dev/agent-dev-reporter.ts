import path from 'node:path';
import { type Plugin, createLogger } from 'vite';

// Agent-friendly dev-server reporter.
//
// Ports the useful half of Astro 7's "AI agent dev mode" onto Push's existing
// Vite 8 setup: detect when a coding agent is driving the dev server and, when
// it is, emit one-line structured JSON for the lifecycle/error events an agent
// otherwise has to scrape out of Vite's ANSI-decorated human output. The
// pretty human logger is preserved underneath, so interactive runs are
// unchanged — the JSON is purely additive and only in agent mode.
//
// Event shape follows the repo's "symmetric structured logs" convention
// (CLAUDE.md): one JSON object per line, `{ level, event, source, t, ...ctx }`.
// Events: `dev_server_ready`, `hmr_update`, `hmr_error`, `vite_warn`,
// `vite_error`. (`hmr_update` ↔ `hmr_error` pair the success/failure halves of
// a hot pass; a transform failure may also surface on the logger as
// `vite_error` — they're distinct channels, not duplicates.)

// Env vars set by the harnesses of common coding agents. Presence of any one
// flips the reporter on. `PUSH_DEV_AGENT` is the explicit override and wins
// either way, so a human can force JSON on (`=1`) or an agent can force it off
// (`=0`) without guessing which detector fired.
const KNOWN_AGENT_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CURSOR_AGENT',
  'AIDER',
  'REPLIT_AGENT',
  'CODEX_CI',
  'CODEX_HOME',
];

export function isAgentDev(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.PUSH_DEV_AGENT?.toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'off') return false;
  if (explicit === '1' || explicit === 'true' || explicit === 'on') return true;
  return KNOWN_AGENT_ENV.some((key) => Boolean(env[key]));
}

// Vite messages arrive pre-colored; strip SGR codes so the JSON `message`
// field is clean for a machine consumer. The pattern is built from the ESC
// code at runtime rather than a literal control char in the regex source
// (keeps `no-control-regex` happy) and strips the leading ESC, not just the
// `[..m` tail.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export type AgentDevLevel = 'info' | 'warn' | 'error';

// Minimal shapes for the HMR overlay-error interception. Vite 8 emits overlay
// errors via the client environment's hot channel as
// `client.hot.send({ type: 'error', err: prepareError(err) })`; `prepareError`
// produces the `err` fields below. Typed loosely so the wrap doesn't pin to a
// specific Vite internal type across versions.
type HotChannelLike = { send?: (...args: unknown[]) => unknown };
interface HotErrorPayload {
  type?: string;
  err?: {
    message?: string;
    stack?: string;
    id?: string;
    frame?: string;
    plugin?: string;
    loc?: unknown;
  };
}

export interface AgentDevReporterOptions {
  /** Defaults to `process.env`. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a `process.stdout` line writer. Injectable for tests. */
  write?: (line: string) => void;
}

export function agentDevReporter(options: AgentDevReporterOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => void process.stdout.write(line));
  const active = isAgentDev(env);

  const log = (level: AgentDevLevel, event: string, ctx: Record<string, unknown> = {}): void => {
    if (!active) return;
    write(
      `${JSON.stringify({ level, event, source: 'vite-dev', t: new Date().toISOString(), ...ctx })}\n`,
    );
  };

  return {
    name: 'push:agent-dev-reporter',
    // Dev-only: the agent-troubleshooting value is in the long-running server.
    // In `build` this plugin is absent, so production output is untouched.
    apply: 'serve',

    // Wrap Vite's logger so every warn/error ALSO emits structured JSON. This
    // is the channel that carries compile/transform failures — the signal an
    // agent most needs and the thing buried deepest in the pretty overlay.
    config() {
      if (!active) return;
      const base = createLogger('info', { allowClearScreen: false });
      const origWarn = base.warn.bind(base);
      const origWarnOnce = base.warnOnce.bind(base);
      const origError = base.error.bind(base);

      base.warn = (msg, opts) => {
        log('warn', 'vite_warn', { message: stripAnsi(msg) });
        origWarn(msg, opts);
      };
      base.warnOnce = (msg, opts) => {
        log('warn', 'vite_warn', { message: stripAnsi(msg) });
        origWarnOnce(msg, opts);
      };
      base.error = (msg, opts) => {
        const stack = opts?.error?.stack;
        log('error', 'vite_error', { message: stripAnsi(msg), ...(stack ? { stack } : {}) });
        origError(msg, opts);
      };

      // Preserve the live logger object (it carries mutable `hasWarned` state
      // Vite reads), and keep the screen so JSON lines aren't cleared away.
      return { customLogger: base, clearScreen: false };
    },

    // One unambiguous "server is up" line so an agent running the dev server in
    // the background knows when to start, and on which port/URL — instead of
    // racing Vite's ANSI box.
    configureServer(server) {
      if (!active) return;

      // Intercept HMR overlay errors. Vite 8 routes these through the client
      // environment's hot channel (falling back to the legacy `hot`/`ws`
      // aliases on older shapes). We wrap `send`, emit a structured
      // `hmr_error` for `{ type: 'error' }` payloads, then pass through
      // untouched so the browser overlay still renders.
      const channel =
        (server.environments?.client?.hot as HotChannelLike | undefined) ??
        (server as unknown as { hot?: HotChannelLike }).hot ??
        (server as unknown as { ws?: HotChannelLike }).ws;
      const send = channel?.send;
      if (channel && typeof send === 'function') {
        const origSend = send.bind(channel);
        channel.send = (...args: unknown[]) => {
          const payload = args[0] as HotErrorPayload | undefined;
          if (payload && typeof payload === 'object' && payload.type === 'error' && payload.err) {
            const err = payload.err;
            log('error', 'hmr_error', {
              message: stripAnsi(err.message ?? 'unknown HMR error'),
              ...(err.id ? { file: err.id } : {}),
              ...(err.loc ? { loc: err.loc } : {}),
              ...(err.plugin ? { plugin: err.plugin } : {}),
              ...(err.frame ? { frame: stripAnsi(err.frame) } : {}),
              ...(err.stack ? { stack: stripAnsi(err.stack) } : {}),
            });
          }
          return origSend(...args);
        };
      }

      const httpServer = server.httpServer;
      if (!httpServer) return;
      httpServer.once('listening', () => {
        // Defer one tick: Vite assigns `resolvedUrls` around the same listen
        // cycle, so reading it on the next microtask makes the URLs reliable.
        setImmediate(() => {
          const address = httpServer.address();
          const port = address && typeof address === 'object' ? address.port : undefined;
          log('info', 'dev_server_ready', {
            port,
            local: server.resolvedUrls?.local ?? [],
            network: server.resolvedUrls?.network ?? [],
          });
        });
      });
    },

    // Each HMR pass is a checkpoint an agent can correlate edits against.
    handleHotUpdate(ctx) {
      if (!active) return;
      log('info', 'hmr_update', {
        // Forward slashes regardless of host. This event is read by AGENTS (that is
        // the whole point of this reporter), and every other path they see is
        // workspace-relative POSIX. A raw path.relative() emits `src\components\Foo.tsx`
        // on Windows — the odd one out in the agent's context, and unmatchable against
        // the paths it already holds. Same normalization as app/vite.config.ts.
        file: path.relative(ctx.server.config.root, ctx.file).replace(/\\/g, '/'),
        modules: ctx.modules.length,
      });
    },
  };
}
