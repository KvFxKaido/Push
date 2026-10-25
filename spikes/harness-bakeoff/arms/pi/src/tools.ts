// The three shared tools (shared/task.mjs TOOLS), executed in the DO's container.
import { Type, type TSchema } from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { TOOLS } from '../../../shared/task.mjs';

const WORKSPACE = '/workspace';
const MAX_OUTPUT_CHARS = 10_000;
const COMMAND_TIMEOUT_S = 60;
// Keep the container for 10 minutes after the object goes idle, so a resumed run finds its files.
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** The container attached to this Durable Object (`ctx.container`). */
export class Box {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly note: (text: string) => Promise<void>,
  ) {}

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured for this Durable Object');
    return container;
  }

  /**
   * Start the container if it is not running. A fresh start always runs `reset-workspace`, so a
   * container that died mid-run (and lost the agent's edits) is recorded in the run's notes, not hidden.
   */
  async ensure(options: { reset: boolean }): Promise<void> {
    const container = this.container;
    if (container.running) {
      if (options.reset) {
        const reset = await this.run(['reset-workspace']);
        if (reset.exitCode !== 0) throw new Error(`reset-workspace failed: ${reset.stderr}`);
        console.log(JSON.stringify({ level: 'info', event: 'pi_box_reset_running' }));
      }
      return;
    }
    container.start({ image: container.images.base!, enableInternet: false });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const reset = await this.run(['reset-workspace']);
    if (reset.exitCode !== 0) throw new Error(`reset-workspace failed: ${reset.stderr}`);
    if (options.reset) {
      console.log(JSON.stringify({ level: 'info', event: 'pi_box_started' }));
    } else {
      console.log(JSON.stringify({ level: 'warn', event: 'pi_box_restarted_mid_run' }));
      await this.note(
        'container was not running at a tool call; restarted it and reset /workspace (earlier edits lost)',
      );
    }
  }

  private async run(cmd: string[], stdin?: string): Promise<ExecResult> {
    const process = await this.container.exec(cmd, {
      // /workspace does not exist until reset-workspace has made it.
      cwd: cmd[0] === 'reset-workspace' ? '/' : WORKSPACE,
      ...(stdin === undefined ? {} : { stdin: new Blob([stdin]).stream() }),
    });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  /** `bash -lc` in /workspace; `timeout` stops the command and everything it started. */
  async exec(command: string, timeoutS = COMMAND_TIMEOUT_S): Promise<ExecResult> {
    await this.ensure({ reset: false });
    return this.run(['timeout', '--kill-after=5', String(timeoutS), 'bash', '-lc', command]);
  }

  async read(path: string): Promise<ExecResult> {
    await this.ensure({ reset: false });
    return this.run(['cat', '--', path]);
  }

  async write(path: string, content: string): Promise<ExecResult> {
    await this.ensure({ reset: false });
    return this.run(
      ['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write_file', path],
      content,
    );
  }
}

type JsonToolSpec = (typeof TOOLS)[number];

/** shared/task.mjs's JSON Schema, as TypeBox. Every property there is a described string. */
function toTypeBox(schema: JsonToolSpec['parameters']): TSchema {
  const required = new Set<string>(schema.required);
  const properties: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [
    string,
    { type: string; description: string },
  ][]) {
    if (prop.type !== 'string')
      throw new Error(`unsupported parameter type ${prop.type} for ${key}`);
    const typed = Type.String({ description: prop.description });
    properties[key] = required.has(key) ? typed : Type.Optional(typed);
  }
  return Type.Object(properties);
}

function spec(name: string): JsonToolSpec {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`shared/task.mjs has no tool ${name}`);
  return found;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];
const tail = (value: string) => value.slice(-MAX_OUTPUT_CHARS);

export function createTools(box: Box): ToolRegistration[] {
  const runCommand = spec('run_command');
  const readFile = spec('read_file');
  const writeFile = spec('write_file');
  return [
    {
      name: runCommand.name,
      description: runCommand.description,
      parameters: toTypeBox(runCommand.parameters),
      replay: 'unsafe',
      async execute(args) {
        const { command } = args as { command: string };
        const result = await box.exec(command);
        // Same shape the Think arm's tool returns: exit code plus both stream tails.
        return {
          output: text(
            JSON.stringify({
              exitCode: result.exitCode,
              stdout: tail(result.stdout),
              stderr: tail(result.stderr),
            }),
          ),
        };
      },
    },
    {
      name: readFile.name,
      description: readFile.description,
      parameters: toTypeBox(readFile.parameters),
      replay: 'safe',
      async execute(args) {
        const { path } = args as { path: string };
        const result = await box.read(path);
        if (result.exitCode !== 0)
          return { output: text(result.stderr || `cat exited ${result.exitCode}`), isError: true };
        return { output: text(result.stdout) };
      },
    },
    {
      name: writeFile.name,
      description: writeFile.description,
      parameters: toTypeBox(writeFile.parameters),
      replay: 'unsafe',
      async execute(args) {
        const { path, content } = args as { path: string; content: string };
        const result = await box.write(path, content);
        if (result.exitCode !== 0)
          return {
            output: text(result.stderr || `write exited ${result.exitCode}`),
            isError: true,
          };
        return { output: text(`Wrote ${content.length} characters to ${path}`) };
      },
    },
  ];
}
