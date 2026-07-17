/**
 * Local CLI EmbeddingProvider — runs BGE entirely on-device via transformers.js
 * (ONNX), so semantic memory retrieval works with no Worker round-trip.
 *
 * This closes the offline-CLI parity gap: the surface that most benefits from
 * better recall for small models ([[push-cli-delegation-parity-decision]]) no
 * longer needs `PUSH_EMBED_URL` pointing at a deployed Worker.
 *
 * Dependency posture: `@huggingface/transformers` is an *optional* dependency
 * (it drags onnxruntime-node + sharp native binaries the web build/CI never
 * need). It's loaded via a dynamic `import()` with a computed specifier so the
 * CLI typechecks and runs even when the package isn't installed — in that case
 * every embed call returns all-null and retrieval degrades to lexical.
 *
 * Model id is `local:bge-base-en-v1.5`, deliberately distinct from the Worker's
 * `@cf/baai/bge-base-en-v1.5`. Same-model gating in the scorer means CF-embedded
 * and locally-embedded records never cross-compare (the cosine would be
 * meaningless), even though both are 768-dim. Stores are per-surface, so within
 * one CLI store every vector is locally-produced and comparable.
 *
 * Lazy + non-blocking: the model loads on the first `embed()` call, in the
 * background — `embed()` never awaits the load. While the model is loading
 * (including a ~110MB cold-start download) `embed()` returns all-null so
 * retrieval stays lexical and the caller never stalls. This matters because
 * embedding runs inside the memory-write path, which is on the critical path of
 * a delegation's output: a blocking load would delay the agent's actual
 * envelopes (and did — it timed out a daemon integration test). Once the model
 * is warm, subsequent calls embed normally; in a long-lived daemon that's after
 * the first op or two. The cost of non-blocking is that records written during
 * the warmup window are lexical-only until rewritten (the backfill follow-up).
 *
 * Commands that never touch memory (e.g. `push theme show`) never trigger a
 * load, and the common no-dependency case stays silent. Diagnostics go to
 * stderr (never stdout — the CLI's user-output / `--json` channel; see
 * [[push-stdout-is-user-channel-on-cli]]).
 */

import os from 'node:os';
import path from 'node:path';

import {
  type EmbeddingProvider,
  type EmbedResult,
  setDefaultEmbeddingProvider,
} from '../lib/embedding-provider.js';

const LOCAL_MODEL_REPO = 'Xenova/bge-base-en-v1.5';
export const LOCAL_EMBEDDING_MODEL = 'local:bge-base-en-v1.5';

const DEBUG = process.env.PUSH_DEBUG === '1' || process.env.PUSH_DEBUG === 'true';

// Minimal structural types for the bits of transformers.js we touch. We can't
// `import type` from an optional dep that may be absent, so we describe the
// surface ourselves and cast the dynamic import.
type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;
interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
    opts?: { progress_callback?: (progress: unknown) => void },
  ): Promise<Extractor>;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
}

// Load state. We distinguish two failure modes (push-agent review on #824):
//   - packageMissing: the optional dependency isn't installed. Permanent within
//     a process — it never becomes available, so never retry.
//   - a transient load failure (download/network/init while the dep IS present):
//     recoverable. We record `lastFailedAt` and let the next embed() retry after
//     a cooldown, so a blip during the cold download doesn't disable a
//     long-lived daemon for its entire life.
let extractor: Extractor | null = null;
let packageMissing = false;
let loadPromise: Promise<void> | null = null;
let lastFailedAt = 0;
const RETRY_COOLDOWN_MS = 30_000;

function modelsCacheDir(): string {
  return process.env.PUSH_MODELS_DIR || path.join(os.homedir(), '.push', 'models');
}

function logLocal(level: 'debug' | 'warn', event: string, ctx: Record<string, unknown> = {}): void {
  if (level === 'debug' && !DEBUG) return;
  console.error(JSON.stringify({ level, event, ...ctx }));
}

function isDownloadProgress(progress: unknown): boolean {
  return (
    typeof progress === 'object' &&
    progress !== null &&
    (progress as { status?: string }).status === 'download'
  );
}

async function loadExtractor(): Promise<void> {
  let mod: TransformersModule;
  try {
    // Computed specifier: TS skips module resolution, so this compiles without
    // the optional dependency present. Absent at runtime → permanent fallback.
    const moduleName = '@huggingface/transformers';
    mod = (await import(moduleName)) as unknown as TransformersModule;
  } catch (error) {
    // Package not installed → permanent. Debug-level: an absent optional
    // dependency is the expected, benign case (lexical fallback), not a failure
    // to shout about on every run. PUSH_DEBUG surfaces it when diagnosing
    // "why isn't semantic working".
    packageMissing = true;
    logLocal('debug', 'local_embed_unavailable', {
      hint: 'install @huggingface/transformers to enable offline semantic memory',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  try {
    mod.env.cacheDir = modelsCacheDir();
    let announced = false;
    extractor = await mod.pipeline('feature-extraction', LOCAL_MODEL_REPO, {
      progress_callback: (progress) => {
        // One-time notice on a cold download so a multi-second first run isn't a
        // silent hang. Subsequent runs load from disk and never hit this.
        if (!announced && isDownloadProgress(progress)) {
          announced = true;
          process.stderr.write(
            '[push] downloading local embedding model (bge-base, ~110MB, one-time)…\n',
          );
        }
      },
    });
    lastFailedAt = 0;
    logLocal('debug', 'local_embed_ready', { model: LOCAL_EMBEDDING_MODEL });
  } catch (error) {
    // Transient (download/network/init): the dep IS installed, so this is a real
    // failure worth a warn — but recoverable. Record the time so a later embed()
    // retries after the cooldown instead of disabling local embeddings forever.
    extractor = null;
    lastFailedAt = Date.now();
    logLocal('warn', 'local_embed_load_failed', {
      retryAfterMs: RETRY_COOLDOWN_MS,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function ensureLoading(): void {
  if (packageMissing || extractor || loadPromise) return;
  // Back off after a transient failure so we don't hammer a failing download on
  // every memory op; a later op past the cooldown retries.
  if (lastFailedAt && Date.now() - lastFailedAt < RETRY_COOLDOWN_MS) return;
  loadPromise = loadExtractor().finally(() => {
    loadPromise = null;
  });
}

/**
 * Block until the model is loaded, returning whether it's ready. For deliberate
 * batch work (backfill) where blocking is correct — unlike the embed() hot path.
 * Bypasses the transient-failure cooldown: an explicit, user-initiated request
 * should force a fresh load attempt rather than honor a recent backoff.
 */
export async function warmupLocalEmbedder(): Promise<boolean> {
  if (packageMissing) return false;
  if (extractor) return true;
  if (!loadPromise) {
    loadPromise = loadExtractor().finally(() => {
      loadPromise = null;
    });
  }
  await loadPromise;
  return Boolean(extractor);
}

export function createLocalEmbeddingProvider(): EmbeddingProvider {
  return {
    model: LOCAL_EMBEDDING_MODEL,
    warmup: warmupLocalEmbedder,
    async embed(texts: string[]): Promise<EmbedResult[]> {
      const allNull = (): EmbedResult[] =>
        texts.map(() => ({ model: LOCAL_EMBEDDING_MODEL, vector: null }));
      // Short-circuit before any model load: nothing to embed, nothing to load.
      if (texts.length === 0) return [];
      if (packageMissing) return allNull();
      if (!extractor) {
        // Kick the load in the background and return lexical-now. We do NOT await
        // it: this runs in the memory-write path on the critical path of a
        // delegation's output, so blocking here would stall the agent (and time
        // out the daemon integration test). Records written before the model is
        // warm stay lexical-only until rewritten/backfilled.
        ensureLoading();
        // Log the degradation: these records go out vector-less (lexical) because
        // the model isn't warm yet. Debug-gated — fires per memory op during the
        // warmup window, not once per run. (push-agent review on #824.)
        logLocal('debug', 'local_embed_warming', { count: texts.length });
        return allNull();
      }
      try {
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        const vectors = output.tolist();
        return texts.map((_, i) => ({ model: LOCAL_EMBEDDING_MODEL, vector: vectors[i] ?? null }));
      } catch (error) {
        logLocal('warn', 'local_embed_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return allNull();
      }
    },
  };
}

/** Test seam: reset the lazily-loaded module state. */
export function __resetLocalEmbedderForTests(): void {
  extractor = null;
  packageMissing = false;
  loadPromise = null;
  lastFailedAt = 0;
}

// Re-export so the install site can wire local without importing the engine.
export { setDefaultEmbeddingProvider };
