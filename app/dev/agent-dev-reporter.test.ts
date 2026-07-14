import { describe, expect, it } from 'vitest';
import { agentDevReporter, isAgentDev } from './agent-dev-reporter';

// The plugin's hooks are typed as Vite's `ObjectHook` union; in this plugin
// they're plain functions, so the tests narrow them through `unknown` to the
// exact callable shape each hook implements (no `any`).
type WrappedLogger = {
  warn: (msg: string) => void;
  error: (msg: string, opts?: { error?: Error }) => void;
};
type ConfigHook = (
  config: object,
  env: object,
) => { customLogger: WrappedLogger; clearScreen: boolean } | undefined;
type HotUpdateHook = (ctx: {
  server: { config: { root: string } };
  file: string;
  modules: unknown[];
}) => void;
type HotChannel = { send: (...args: unknown[]) => unknown };
type ConfigureServerHook = (server: {
  httpServer: null;
  environments: { client: { hot: HotChannel } };
}) => void;

const ESC = String.fromCharCode(27);

function captureWriter() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => void lines.push(line),
    events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('isAgentDev', () => {
  it('detects known agent env vars', () => {
    expect(isAgentDev({ CLAUDECODE: '1' })).toBe(true);
    expect(isAgentDev({ CURSOR_AGENT: 'x' })).toBe(true);
    expect(isAgentDev({ CODEX_HOME: '/home/user/.codex' })).toBe(true);
    expect(isAgentDev({ CODEX_CI: '1' })).toBe(true);
    expect(isAgentDev({})).toBe(false);
  });

  it('honors the explicit PUSH_DEV_AGENT override either way', () => {
    // Forced off even though an agent var is present.
    expect(isAgentDev({ PUSH_DEV_AGENT: '0', CLAUDECODE: '1' })).toBe(false);
    expect(isAgentDev({ PUSH_DEV_AGENT: 'false', AIDER: '1' })).toBe(false);
    // Forced on with no agent var present.
    expect(isAgentDev({ PUSH_DEV_AGENT: '1' })).toBe(true);
    expect(isAgentDev({ PUSH_DEV_AGENT: 'on' })).toBe(true);
  });
});

describe('agentDevReporter', () => {
  it('only applies in serve (dev), never in build', () => {
    const plugin = agentDevReporter({ env: { CLAUDECODE: '1' } });
    expect(plugin.apply).toBe('serve');
  });

  it('emits structured JSON for warn/error through the wrapped logger in agent mode', () => {
    const cap = captureWriter();
    const plugin = agentDevReporter({ env: { CLAUDECODE: '1' }, write: cap.write });

    const config = plugin.config as unknown as ConfigHook;
    const result = config({}, { command: 'serve', mode: 'development' });
    expect(result?.customLogger).toBeDefined();
    expect(result?.clearScreen).toBe(false);

    // Real SGR-wrapped message to exercise the ANSI stripper end to end.
    result?.customLogger.warn(`${ESC}[33ma warning${ESC}[39m`);
    result?.customLogger.error('boom', { error: new Error('boom') });

    const events = cap.events();
    const warn = events.find((e) => e.event === 'vite_warn');
    const error = events.find((e) => e.event === 'vite_error');

    expect(warn).toMatchObject({ level: 'warn', source: 'vite-dev', message: 'a warning' });
    expect(error).toMatchObject({ level: 'error', source: 'vite-dev', message: 'boom' });
    expect(typeof error?.stack).toBe('string');
  });

  it('emits hmr_update with a root-relative path', () => {
    const cap = captureWriter();
    const plugin = agentDevReporter({ env: { CLAUDECODE: '1' }, write: cap.write });

    const handleHotUpdate = plugin.handleHotUpdate as unknown as HotUpdateHook;
    handleHotUpdate({
      server: { config: { root: '/repo' } },
      file: '/repo/src/components/Foo.tsx',
      modules: [{}, {}],
    });

    expect(cap.events()).toContainEqual(
      expect.objectContaining({
        event: 'hmr_update',
        file: 'src/components/Foo.tsx',
        modules: 2,
      }),
    );

    // POSIX separators regardless of host. This event is read by AGENTS, and every
    // other path they hold is workspace-relative POSIX — a raw path.relative() emits
    // `src\components\Foo.tsx` on Windows, which no agent can match against what it
    // already has.
    //
    // NOTE: on Linux CI this assertion is vacuous — path.relative never yields a
    // backslash there, so it passes whether or not the normalization exists. It is
    // the requirement written down, not a guard. The only thing that actually catches
    // a regression here is running the suite on Windows, which is precisely why this
    // shipped broken: the `test (cli)` and app jobs are Linux-only.
    const hmr = cap.events().find((e) => e.event === 'hmr_update');
    expect(String(hmr?.file)).not.toContain('\\');
  });

  it('emits hmr_error for overlay-error payloads and still passes them through', () => {
    const cap = captureWriter();
    const plugin = agentDevReporter({ env: { CLAUDECODE: '1' }, write: cap.write });

    const forwarded: unknown[] = [];
    const hot: HotChannel = { send: (...args: unknown[]) => void forwarded.push(args[0]) };
    const configureServer = plugin.configureServer as unknown as ConfigureServerHook;
    configureServer({ httpServer: null, environments: { client: { hot } } });

    const errorPayload = {
      type: 'error',
      err: {
        message: `${ESC}[31mUnexpected token${ESC}[39m`,
        id: '/repo/src/Broken.tsx',
        frame: 'const x =',
        plugin: 'vite:react-babel',
        loc: { file: 'src/Broken.tsx', line: 3, column: 9 },
        stack: 'SyntaxError: Unexpected token',
      },
    };
    hot.send(errorPayload);

    // Non-error traffic must not be reported.
    hot.send({ type: 'update', updates: [] });

    const events = cap.events();
    const hmrError = events.find((e) => e.event === 'hmr_error');
    expect(hmrError).toMatchObject({
      level: 'error',
      source: 'vite-dev',
      message: 'Unexpected token',
      file: '/repo/src/Broken.tsx',
      plugin: 'vite:react-babel',
    });
    expect(events.filter((e) => e.event === 'hmr_error')).toHaveLength(1);

    // Both sends pass through to the real channel untouched (overlay intact).
    expect(forwarded).toEqual([errorPayload, { type: 'update', updates: [] }]);
  });

  it('is inert when no agent is detected', () => {
    const cap = captureWriter();
    const plugin = agentDevReporter({ env: {}, write: cap.write });

    const config = plugin.config as unknown as ConfigHook;
    const handleHotUpdate = plugin.handleHotUpdate as unknown as HotUpdateHook;

    // No customLogger override and nothing written.
    expect(config({}, { command: 'serve', mode: 'development' })).toBeUndefined();
    handleHotUpdate({
      server: { config: { root: '/repo' } },
      file: '/repo/src/a.ts',
      modules: [{}],
    });
    expect(cap.lines).toHaveLength(0);
  });
});
