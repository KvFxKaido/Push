// Bake-off arm: one coding task on @cloudflare/think, tools in the DO's container.
//
//   POST /run                 run the task to completion, return { run, transcript }
//   POST /start               durably submit the task, return { runId } at once
//   GET  /status?runId=<id>   submission status; { run, transcript } once terminal
//
// Each run gets its own DO (and so its own container), named by runId.
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  Think,
  type StepContext,
  type ToolCallResultContext,
  type TurnContext,
} from '@cloudflare/think';
import { getAgentByName } from 'agents';
import { jsonSchema, tool, type ToolSet, type UIMessage } from 'ai';
import { MODEL, SYSTEM_PROMPT, TASK_PROMPT, TOOLS } from '../../../shared/task.mjs';

interface Env {
  MODEL_BASE_URL: string;
  ThinkArm: DurableObjectNamespace<ThinkArm>;
}

const OUTPUT_CHARS = 10_000;
const TOOL_TIMEOUT_S = 60;
const TEST_TIMEOUT_S = 120;
const INACTIVITY_MS = 30 * 60 * 1000;
const ACTIVE_TOOLS = TOOLS.map((t) => t.name);

type ToolCallRecord = { name: string; input: unknown; output: string };
type Usage = { inputTokens: number | null; outputTokens: number | null };
type Meta = { runId: string; startedAt: string; startedMs: number; submissionId?: string };

const log = (level: string, event: string, ctx: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, event, ...ctx }));

export class ThinkArm extends Think<Env> {
  // Think's default is 10 steps per turn, which can cut a fix-and-verify loop
  // short. Raised so the step cap is not the variable under test.
  override maxSteps = 50;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted DO loses the inactivity timeout; set it again (per the Sandbox docs).
    if (container?.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
  }

  override getModel() {
    // The run id in the path lets the proxy file each request under its run;
    // timestamps can't, because the WSL clock drifts from the proxy's.
    const anthropic = createAnthropic({
      baseURL: `${this.env.MODEL_BASE_URL}/${this.name}/v1`,
      apiKey: 'via-bakeoff-proxy',
    });
    return anthropic(MODEL);
  }

  override getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  // Think appends a "You are running inside a Think agent" capability block to
  // getSystemPrompt() unless beforeTurn returns `system`, so pin it here to keep
  // the shared prompt word for word. activeTools hides Think's built-in workspace tools.
  override beforeTurn(_ctx: TurnContext) {
    return { system: SYSTEM_PROMPT, activeTools: ACTIVE_TOOLS };
  }

  override getTools(): ToolSet {
    const spec = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
    const def = (name: string, execute: (input: any) => Promise<string>) =>
      tool({
        description: spec[name].description,
        inputSchema: jsonSchema<any>(spec[name].parameters as any),
        execute,
      });
    return {
      run_command: def('run_command', ({ command }) => this.runCommand(command)),
      read_file: def('read_file', ({ path }) => this.readFile(path)),
      write_file: def('write_file', ({ path, content }) => this.writeFile(path, content)),
    };
  }

  // Our own record of every call, kept in DO storage so it survives a restart.
  override async afterToolCall(ctx: ToolCallResultContext) {
    const calls = (await this.ctx.storage.get<ToolCallRecord[]>('toolCalls')) ?? [];
    const output = ctx.success
      ? typeof ctx.output === 'string'
        ? ctx.output
        : JSON.stringify(ctx.output)
      : `error: ${ctx.error instanceof Error ? ctx.error.message : String(ctx.error)}`;
    calls.push({ name: ctx.toolName, input: ctx.input, output });
    await this.ctx.storage.put('toolCalls', calls);
  }

  override async onStepFinish(ctx: StepContext) {
    const usage = (await this.ctx.storage.get<Usage>('usage')) ?? {
      inputTokens: null,
      outputTokens: null,
    };
    const add = (a: number | null, b: number | undefined) => (b == null ? a : (a ?? 0) + b);
    await this.ctx.storage.put('usage', {
      inputTokens: add(usage.inputTokens, ctx.usage?.inputTokens),
      outputTokens: add(usage.outputTokens, ctx.usage?.outputTokens),
    });
  }

  // ---- entry points (RPC from the Worker) ----

  async runSync(runId: string) {
    await this.begin(runId);
    const result = await this.runTurn({ input: TASK_PROMPT });
    log('info', 'think_turn_finished', { runId, status: result.status });
    if (result.status !== 'completed')
      await this.note(`runTurn ended with status "${result.status}"`);
    return this.finalize();
  }

  async startAsync(runId: string) {
    await this.begin(runId);
    const submission = await this.runTurn({
      mode: 'submit',
      input: TASK_PROMPT,
      idempotencyKey: runId,
    });
    const meta = (await this.ctx.storage.get<Meta>('meta'))!;
    await this.ctx.storage.put('meta', { ...meta, submissionId: submission.submissionId });
    log('info', 'think_submission_accepted', {
      runId,
      submissionId: submission.submissionId,
      accepted: submission.accepted,
    });
    return { runId, submissionId: submission.submissionId, status: submission.status };
  }

  async status() {
    const meta = await this.ctx.storage.get<Meta>('meta');
    if (!meta?.submissionId) {
      log('warn', 'think_status_unknown_run');
      return { status: 'unknown' as const };
    }
    const done = await this.ctx.storage.get('final');
    if (done) return { status: 'completed' as const, ...(done as object) };
    const submission = await this.inspectSubmission(meta.submissionId);
    if (!submission || submission.status === 'pending' || submission.status === 'running') {
      log('info', 'think_status_in_flight', {
        runId: meta.runId,
        status: submission?.status ?? 'missing',
      });
      return { status: submission?.status ?? 'missing', submission };
    }
    log('info', 'think_status_terminal', { runId: meta.runId, status: submission.status });
    if (submission.status !== 'completed')
      await this.note(
        `submission ended with status "${submission.status}": ${submission.error ?? ''}`,
      );
    const final = await this.finalize();
    await this.ctx.storage.put('final', final);
    return { status: submission.status, ...final };
  }

  // ---- run bookkeeping ----

  private async begin(runId: string) {
    const startedMs = Date.now();
    await this.ctx.storage.put('meta', {
      runId,
      startedAt: new Date(startedMs).toISOString(),
      startedMs,
    } satisfies Meta);
    await this.ensureContainer();
    const reset = await this.exec(['reset-workspace']);
    if (reset.exitCode !== 0) throw new Error(`reset-workspace failed: ${reset.stderr}`);
    log('info', 'think_workspace_reset', { runId });
    await this.ctx.storage.put('workspaceReady', true);
  }

  private async finalize() {
    const meta = (await this.ctx.storage.get<Meta>('meta'))!;
    await this.ensureContainer();
    // Host-side verification: the model never sees these.
    const test = await this.exec(
      ['timeout', '--kill-after=5', String(TEST_TIMEOUT_S), 'bash', '-lc', 'npm test 2>&1'],
      '/workspace',
    );
    const diff = await this.exec(['git', 'diff', '--', '.', ':(exclude)test'], '/workspace');
    const testsDiff = await this.exec(['git', 'diff', '--', 'test'], '/workspace');
    const transcript: UIMessage[] = this.messages;
    const lastAssistant = [...transcript].reverse().find((m) => m.role === 'assistant');
    const finalText = (lastAssistant?.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const notes = (await this.ctx.storage.get<string[]>('notes')) ?? [];
    const run = {
      arm: 'think' as const,
      runId: meta.runId,
      model: MODEL,
      startedAt: meta.startedAt,
      wallMs: Date.now() - meta.startedMs,
      finalText,
      toolCalls: (await this.ctx.storage.get<ToolCallRecord[]>('toolCalls')) ?? [],
      usage: (await this.ctx.storage.get<Usage>('usage')) ?? {
        inputTokens: null,
        outputTokens: null,
      },
      verify: {
        testExit: test.exitCode,
        testOutput: test.stdout,
        diff: diff.stdout,
        testsDiff: testsDiff.stdout,
      },
      transcriptPath: '', // filled in by run.mjs, which owns the filesystem
      notes: [
        'toolCalls: recorded by the arm in afterToolCall (DO storage), not parsed from the transcript',
        'usage: summed from onStepFinish ctx.usage across steps; a step cut off by an interruption is not counted',
        `maxSteps raised from Think default 10 to ${this.maxSteps}`,
        "system prompt pinned via beforeTurn({ system }) to suppress Think's appended capability block",
        ...notes,
      ],
    };
    return { run, transcript };
  }

  private async note(text: string) {
    const notes = (await this.ctx.storage.get<string[]>('notes')) ?? [];
    notes.push(text);
    await this.ctx.storage.put('notes', notes);
  }

  // ---- container ----

  private async ensureContainer() {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured for this Durable Object');
    if (container.running) return;
    // No `entrypoint`: the image's own ENTRYPOINT is `sleep infinity`. Passing
    // entrypoint too made local dev run `sleep infinity sleep infinity` (it sets
    // Cmd as well), which exits 1 and crash-loops the container.
    container.start({ image: container.images.bakeoff, enableInternet: false });
    await container.setInactivityTimeout(INACTIVITY_MS);
    // start() returns before the container is ready; poll until exec works.
    for (let attempt = 1; ; attempt++) {
      try {
        await (await container.exec(['true'])).exitCode;
        log('info', 'think_container_ready', { attempt });
        break;
      } catch (error) {
        if (attempt >= 30) {
          log('error', 'think_container_not_ready', { attempt, message: String(error) });
          throw error;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // A fresh container after a restart has no /workspace (it is created per run,
    // not baked in). Say so in the record rather than pretending nothing happened.
    if (!(await this.ctx.storage.get('workspaceReady'))) return; // first start: begin() resets it
    const meta = await this.ctx.storage.get<Meta>('meta');
    const has = await this.exec(['test', '-d', '/workspace']);
    if (has.exitCode !== 0) {
      log('warn', 'think_container_restarted_mid_run', { runId: meta?.runId });
      await this.note(
        'container was (re)started mid-run with no /workspace: reset-workspace re-ran, earlier edits lost',
      );
      await this.exec(['reset-workspace']);
    }
  }

  private async exec(cmd: string[], cwd?: string, stdin?: string) {
    const proc = await this.ctx.container!.exec(cmd, {
      cwd,
      ...(stdin != null && { stdin: new Response(stdin).body! }),
    });
    const out = await proc.output();
    const decode = (b: ArrayBuffer) => new TextDecoder().decode(b).slice(-OUTPUT_CHARS);
    return { exitCode: out.exitCode, stdout: decode(out.stdout), stderr: decode(out.stderr) };
  }

  // ---- the three shared tools ----

  private async runCommand(command: string) {
    await this.ensureContainer();
    // `timeout` kills the command and everything it started (exit 124 on timeout).
    const r = await this.exec(
      ['timeout', '--kill-after=5', String(TOOL_TIMEOUT_S), 'bash', '-lc', command],
      '/workspace',
    );
    return JSON.stringify(r);
  }

  private async readFile(path: string) {
    await this.ensureContainer();
    const proc = await this.ctx.container!.exec(['cat', '--', path], { cwd: '/workspace' });
    const out = await proc.output();
    if (out.exitCode !== 0)
      throw new Error(new TextDecoder().decode(out.stderr).trim() || `cat exited ${out.exitCode}`);
    return new TextDecoder().decode(out.stdout);
  }

  private async writeFile(path: string, content: string) {
    await this.ensureContainer();
    const r = await this.exec(
      ['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write_file', path],
      '/workspace',
      content,
    );
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `write exited ${r.exitCode}`);
    return `wrote ${new TextEncoder().encode(content).length} bytes to ${path}`;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/run') {
      const runId = crypto.randomUUID();
      const stub = await getAgentByName(env.ThinkArm, runId);
      return Response.json(await stub.runSync(runId));
    }
    if (request.method === 'POST' && url.pathname === '/start') {
      const runId = crypto.randomUUID();
      const stub = await getAgentByName(env.ThinkArm, runId);
      return Response.json(await stub.startAsync(runId));
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      const runId = url.searchParams.get('runId');
      if (!runId) return new Response('runId required', { status: 400 });
      const stub = await getAgentByName(env.ThinkArm, runId);
      return Response.json(await stub.status());
    }
    return new Response('bake-off think arm: POST /run, POST /start, GET /status?runId=', {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
