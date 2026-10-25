// Minimal declaration of the `cloudflare:workers` runtime module, for the one
// Durable Object that must extend its base class: Workers RPC only exposes a
// Durable Object's methods to stubs when the class extends `DurableObject`.
// The full ambient declarations stay out of the app tsconfig on purpose (see
// the note in coder-job-do.ts); this declares only what sandbox-do.ts uses.
declare module 'cloudflare:workers' {
  import type { DurableObjectState } from '@cloudflare/workers-types';

  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
