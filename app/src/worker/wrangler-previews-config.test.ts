/**
 * Guards the `previews` block in both Wrangler configs.
 *
 * Worker Previews inherit nothing from the top level, so the block is a hand
 * copy, and a copy drifts. It is also the safety boundary for branch builds:
 * on 2026-10-25 a non-production build touched production's container app and
 * took production sandboxes down. These checks keep the boundary in place:
 * - no `previews.containers` (Previews reject the durable_object policy, and a
 *   named entry would point at the top-level app);
 * - data bindings resolve to non-production resources only;
 * - every Durable Object binding and every `define` shim the Worker reads at the
 *   top level is declared again for Previews.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type Binding = { binding?: string; name?: string };
type WranglerConfig = {
  name: string;
  define?: Record<string, string>;
  vars?: Record<string, string>;
  containers?: unknown[];
  kv_namespaces?: Array<Binding & { id: string }>;
  r2_buckets?: Array<Binding & { bucket_name: string }>;
  analytics_engine_datasets?: Array<Binding & { dataset: string }>;
  ratelimits?: Array<Binding & { namespace_id: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  triggers?: unknown;
  observability?: {
    enabled?: boolean;
    logs?: { enabled?: boolean; persist?: boolean };
    traces?: { enabled?: boolean; persist?: boolean };
  };
  previews?: WranglerConfig;
};

/** Strips JSONC comments and trailing commas, leaving string contents alone. */
function parseJsonc(text: string): WranglerConfig {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as WranglerConfig;
}

const load = (file: string) => parseJsonc(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
const production = load('wrangler.jsonc');
const staging = load('wrangler.staging.jsonc');

/** Every resource identifier a config's data bindings point at. */
function resourceIds(cfg: WranglerConfig): Set<string> {
  return new Set([
    ...(cfg.kv_namespaces ?? []).map((b) => b.id),
    ...(cfg.r2_buckets ?? []).map((b) => b.bucket_name),
    ...(cfg.analytics_engine_datasets ?? []).map((b) => b.dataset),
    ...(cfg.ratelimits ?? []).map((b) => b.namespace_id),
  ]);
}

const bindingNames = (list: Binding[] | undefined) =>
  (list ?? []).map((b) => b.binding ?? b.name).sort();

describe.each([
  ['wrangler.jsonc', production],
  ['wrangler.staging.jsonc', staging],
])('%s previews block', (_file, cfg) => {
  const previews = cfg.previews;

  it('exists', () => {
    expect(previews).toBeDefined();
  });

  it('declares no containers', () => {
    expect(previews?.containers).toBeUndefined();
  });

  it('runs Preview sandboxes on Modal', () => {
    expect(previews?.vars?.PUSH_SANDBOX_PROVIDER).toBe('modal');
  });

  it('has no crons', () => {
    expect(previews?.triggers).toBeUndefined();
  });

  // Preview telemetry is configured separately from production; without this a
  // Preview's logs and traces are simply not collected.
  it('keeps Preview logs and traces on and persisted', () => {
    expect(previews?.observability?.enabled).toBe(true);
    expect(previews?.observability?.logs).toMatchObject({ enabled: true, persist: true });
    expect(previews?.observability?.traces).toMatchObject({ enabled: true, persist: true });
  });

  it('copies every define shim exactly', () => {
    expect(previews?.define).toEqual(cfg.define);
  });

  it('redeclares every Durable Object binding', () => {
    expect(previews?.durable_objects?.bindings).toEqual(cfg.durable_objects?.bindings);
  });

  it('redeclares every data binding by name', () => {
    expect(bindingNames(previews?.kv_namespaces)).toEqual(bindingNames(cfg.kv_namespaces));
    expect(bindingNames(previews?.r2_buckets)).toEqual(bindingNames(cfg.r2_buckets));
    expect(bindingNames(previews?.analytics_engine_datasets)).toEqual(
      bindingNames(cfg.analytics_engine_datasets),
    );
    expect(bindingNames(previews?.ratelimits)).toEqual(bindingNames(cfg.ratelimits));
  });
});

describe('production previews isolation', () => {
  it('points no data binding at a production resource', () => {
    const prodIds = resourceIds(production);
    const leaked = [...resourceIds(production.previews ?? ({} as WranglerConfig))].filter((id) =>
      prodIds.has(id),
    );
    expect(prodIds.size).toBeGreaterThan(5);
    expect(leaked).toEqual([]);
  });

  it('uses push-staging resources for its data', () => {
    expect(resourceIds(production.previews ?? ({} as WranglerConfig))).toEqual(
      resourceIds(staging),
    );
  });
});
