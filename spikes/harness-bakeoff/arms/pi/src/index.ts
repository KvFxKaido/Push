// Pi arm of the harness bake-off: one coding task, run by PiHarness (Pi Durable)
// in a Durable Object, with three tools that execute in the DO's container.
import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { MODEL, SYSTEM_PROMPT, TASK_PROMPT } from '../../../shared/task.mjs';
import { Box, createTools } from './tools';
import { scriptedProvider } from './faux';

type Env = {
  PiRun: DurableObjectNamespace<PiRun>;
  MODEL_BASE_URL: string;
  /** "1" swaps the model for a scripted stand-in (src/faux.ts). Plumbing checks only. */
  FAUX?: string;
};

// Our own provider id, so nothing can fall back to pi-ai's built-in Anthropic
// provider (which reads ANTHROPIC_API_KEY and talks to api.anthropic.com).
const PROVIDER = 'bakeoff-proxy';
// The proxy injects the real credential and ignores this one.
const PLACEHOLDER_KEY = 'via-bakeoff-proxy';

/** pi-ai's own catalog entry for the model, pointed at the bake-off proxy. */
function proxiedModel(baseUrl: string) {
  const entry = Object.values(ANTHROPIC_MODELS).find((m) => m.id === MODEL);
  if (!entry) throw new Error(`pi-ai's Anthropic catalog has no ${MODEL}`);
  return { ...entry, provider: PROVIDER, baseUrl };
}

type RunMeta = { runId: string; startedAt: string; startedMs: number; notes: string[] };

export class PiRun extends DurableObject<Env> {
  readonly box = new Box(this.ctx, (note) => this.addNote(note));
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // Exactly one extension: the shared system prompt and the three shared tools.
      // The registry starts empty, so pi offers no built-in tools.
      this.registry.install({
        name: 'bakeoff',
        sections: [{ key: 'system', render: () => SYSTEM_PROMPT, tag: false }],
        tools: createTools(this.box),
      });
      const models = createModels();
      // The run id (this DO's name) in the path lets the proxy file each request
      // under its run; timestamps can't, because the WSL clock drifts from the proxy's.
      const runBaseUrl = `${this.env.MODEL_BASE_URL}/${this.ctx.id.name}`;
      if (this.env.FAUX === '1') {
        console.log(JSON.stringify({ level: 'warn', event: 'pi_model_faux' }));
        models.setProvider(scriptedProvider(PROVIDER, MODEL));
      } else
        models.setProvider(
          createProvider({
            id: PROVIDER,
            name: 'Bake-off model proxy (Anthropic Messages)',
            baseUrl: runBaseUrl,
            auth: {
              apiKey: {
                name: 'bake-off proxy',
                resolve: async () => ({ auth: { apiKey: PLACEHOLDER_KEY } }),
              },
            },
            models: [proxiedModel(runBaseUrl)],
            api: anthropicMessagesApi(),
          }),
        );
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          onReport: (error, info) => this.addNote(`pi report ${info.type}: ${String(error)}`),
        },
        context,
      );
    },
    defaults: { model: { provider: PROVIDER, id: MODEL } },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async addNote(note: string): Promise<void> {
    const meta = await this.ctx.storage.get<RunMeta>('meta');
    if (!meta) return;
    meta.notes.push(note);
    await this.ctx.storage.put('meta', meta);
  }

  /** A host-side check. A dead container is reported as exit -1 with the error, never thrown. */
  private async hostExec(command: string, timeoutS: number) {
    try {
      return await this.box.exec(command, timeoutS);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'pi_host_check_failed',
          command,
          message: String(error),
        }),
      );
      await this.addNote(`host check \`${command}\` could not run: ${String(error)}`);
      return { exitCode: -1, stdout: '', stderr: `host check could not run: ${String(error)}` };
    }
  }

  /** Start the container, reset the workspace, and durably submit the task. Returns before the model runs. */
  async start(runId: string): Promise<{ runId: string; operationId: string; accepted: boolean }> {
    if (!(await this.ctx.storage.get('meta'))) {
      const now = Date.now();
      const meta: RunMeta = {
        runId,
        startedAt: new Date(now).toISOString(),
        startedMs: now,
        notes: [],
      };
      await this.ctx.storage.put('meta', meta);
      try {
        await this.box.ensure({ reset: true });
      } catch (error) {
        // Recorded, not thrown: the run still goes ahead so the record shows what a missing box does.
        console.error(
          JSON.stringify({ level: 'error', event: 'pi_box_start_failed', message: String(error) }),
        );
        await this.addNote(`container start failed before the task: ${String(error)}`);
      }
    }
    // operationId = runId makes a retried start return the same operation (accepted: false).
    const receipt = await this.harness.submit(TASK_PROMPT, { operationId: runId });
    return { runId, operationId: receipt.operationId, accepted: receipt.accepted };
  }

  /** What pi has not settled yet, straight from pi. */
  async status(): Promise<{ pending: unknown; busy: boolean; finished: boolean }> {
    return {
      pending: await this.harness.pending(),
      busy: await this.harness.session().busy(),
      finished: (await this.ctx.storage.get('record')) !== undefined,
    };
  }

  /** Wait for pi to settle the task, then verify host-side and build the run record. Idempotent. */
  async result(): Promise<{ record: unknown; transcript: unknown }> {
    const done = await this.ctx.storage.get<{ record: unknown; transcript: unknown }>('record');
    if (done) return done;
    const meta = await this.ctx.storage.get<RunMeta>('meta');
    if (!meta) throw new Error('no run in this object; POST /run first');

    const outcome = await this.harness.wait(meta.runId);
    const wallMs = Date.now() - meta.startedMs;

    // Host-side checks, never through the model.
    const test = await this.hostExec('npm test', 120);
    const diff = await this.hostExec("git diff -- . ':(exclude)test'", 30);
    const testsDiff = await this.hostExec('git diff -- test', 30);

    // pi's own record, untouched.
    const messages = await this.harness.messages();
    const stream = await this.harness.session().events();
    const eventsSnapshot = stream.snapshot;
    await stream.stop();
    const pi = await this.harness.pi();
    const usageState = await pi.usage(BACKGROUND_CONTEXT);
    const transcript = {
      messages,
      eventsSnapshot,
      usage: usageState,
      outcome,
      pending: await this.harness.pending(),
    };

    const usage = usageState.models[`${PROVIDER}/${MODEL}`];
    const final = await this.ctx.storage.get<RunMeta>('meta');
    const notes = [...(final?.notes ?? [])];
    if (this.env.FAUX === '1')
      notes.push('FAUX=1: scripted stand-in model (src/faux.ts); NOT a real run');
    notes.push(`pi outcome: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    notes.push(
      "toolCalls are rebuilt from pi's transcript (pi.assistant toolCall parts paired with pi.tool-result entries by call id).",
    );
    notes.push("thinkingLevel left at pi's default ('off').");
    if (usage)
      notes.push(
        `usage from pi.usage: cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} totalTokens=${usage.totalTokens}`,
      );
    else notes.push('pi.usage had no entry for the model; usage is null');

    const record = {
      arm: 'pi',
      runId: meta.runId,
      model: MODEL,
      startedAt: meta.startedAt,
      wallMs,
      finalText: outcome.text ?? '',
      toolCalls: toolCallsFrom(messages),
      usage: { inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null },
      verify: {
        testExit: test.exitCode,
        testOutput: test.stdout + test.stderr,
        diff: diff.stdout,
        testsDiff: testsDiff.stdout,
      },
      transcriptPath: '',
      notes,
    };
    const saved = { record, transcript };
    await this.ctx.storage.put('record', saved);
    return saved;
  }
}

type Part = { type: string; id?: string; name?: string; arguments?: unknown; text?: string };
type Msg = { role: string; content?: Part[] | string; toolCallId?: string };

/** Every tool call with its input and output, from pi's transcript entries. */
function toolCallsFrom(entries: readonly { kind: string; model?: readonly unknown[] }[]) {
  const outputs = new Map<string, string>();
  const calls: { id: string; name: string; input: unknown }[] = [];
  for (const entry of entries) {
    for (const raw of entry.model ?? []) {
      const msg = raw as Msg;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'toolCall')
            calls.push({ id: part.id!, name: part.name!, input: part.arguments });
        }
      } else if (msg.role === 'toolResult' && msg.toolCallId && Array.isArray(msg.content)) {
        outputs.set(
          msg.toolCallId,
          msg.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join(''),
        );
      }
    }
  }
  return calls.map(({ id, name, input }) => ({
    name,
    input,
    output: outputs.get(id) ?? '[no result in transcript]',
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/run') {
        // A fresh DO per run. ?wait=0 returns the receipt at once (for the interruption test).
        const runId = `pi-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
        const stub = env.PiRun.getByName(runId);
        const receipt = await stub.start(runId);
        if (url.searchParams.get('wait') === '0') return Response.json(receipt);
        return Response.json(await stub.result());
      }
      const match = url.pathname.match(/^\/runs\/([\w-]+)\/(status|result)$/);
      if (request.method === 'GET' && match) {
        const stub = env.PiRun.getByName(match[1]!);
        return Response.json(match[2] === 'status' ? await stub.status() : await stub.result());
      }
      return new Response('POST /run, GET /runs/<id>/status, GET /runs/<id>/result', {
        status: 404,
      });
    } catch (error) {
      console.error(
        JSON.stringify({ level: 'error', event: 'pi_arm_request_failed', message: String(error) }),
      );
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
