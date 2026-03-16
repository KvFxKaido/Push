/**
 * Shared agent working memory types and state management.
 *
 * Provides the CoderWorkingMemory type system and state mutation
 * logic used by both the web app (coder-agent.ts) and CLI (engine.mjs).
 *
 * Extracted from app/src/types/index.ts and app/src/lib/coder-agent.ts
 * during Track 2 convergence.
 */

import { detectToolFromText, asRecord } from './tool-protocol.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface CoderObservation {
  id: string;
  text: string;
  dependsOn?: string[];
  stale?: boolean;
  staleReason?: string;
  addedAtRound?: number;
  staleAtRound?: number;
}

export interface CoderWorkingMemory {
  plan?: string;
  openTasks?: string[];
  filesTouched?: string[];
  assumptions?: string[];
  errorsEncountered?: string[];
  currentPhase?: string;
  completedPhases?: string[];
  observations?: CoderObservation[];
}

export type CoderObservationUpdate = {
  id: string;
  text?: string;
  dependsOn?: string[];
  remove?: boolean;
};

export type CoderWorkingMemoryUpdate = Omit<Partial<CoderWorkingMemory>, 'observations'> & {
  observations?: CoderObservationUpdate[];
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a fresh, empty working memory. */
export function createWorkingMemory(): CoderWorkingMemory {
  return {
    plan: '',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
    currentPhase: '',
    completedPhases: [],
  };
}

// ---------------------------------------------------------------------------
// State mutation
// ---------------------------------------------------------------------------

/** Deduplicate and trim a string array, preserving order. */
function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Apply a partial update to working memory (additive for arrays).
 * Returns the updated memory object.
 */
export function applyWorkingMemoryUpdate(
  mem: CoderWorkingMemory,
  update: CoderWorkingMemoryUpdate,
  round = 0,
): CoderWorkingMemory {
  if (typeof update.plan === 'string') mem.plan = update.plan;
  if (Array.isArray(update.openTasks)) mem.openTasks = uniqueStrings(update.openTasks);
  if (Array.isArray(update.filesTouched)) mem.filesTouched = uniqueStrings(update.filesTouched);
  if (Array.isArray(update.assumptions)) mem.assumptions = uniqueStrings(update.assumptions);
  if (Array.isArray(update.errorsEncountered)) mem.errorsEncountered = uniqueStrings(update.errorsEncountered);
  if (typeof update.currentPhase === 'string') mem.currentPhase = update.currentPhase;
  if (Array.isArray(update.completedPhases)) mem.completedPhases = uniqueStrings(update.completedPhases);
  if (update.observations) {
    mem.observations = applyObservationUpdates(mem.observations, update.observations, round);
  }
  return mem;
}

// ---------------------------------------------------------------------------
// Observation management
// ---------------------------------------------------------------------------

/**
 * Apply observation updates (add/update/remove) to existing observations.
 */
export function applyObservationUpdates(
  existing: CoderObservation[] | undefined,
  updates: CoderObservationUpdate[] | undefined,
  round: number,
): CoderObservation[] | undefined {
  if (!updates?.length) return existing;

  const next = [...(existing || [])];

  for (const update of updates) {
    const id = update.id.trim();
    const index = next.findIndex((o) => o.id === id);

    if (update.remove) {
      if (index !== -1) next.splice(index, 1);
      continue;
    }

    if (typeof update.text !== 'string') continue;

    const dependsOn = update.dependsOn?.length ? [...new Set(update.dependsOn)] : undefined;
    const updatedObservation: CoderObservation = {
      id,
      text: update.text,
      dependsOn,
      addedAtRound: index === -1 ? round : next[index].addedAtRound,
    };

    if (index === -1) {
      next.push(updatedObservation);
    } else {
      next[index] = updatedObservation;
    }
  }

  return next.length ? next : undefined;
}

/** Strip /workspace/ prefix for consistent path comparison. */
function normalizeObservationPath(p: string): string {
  return p.replace(/^\/workspace\//, '').replace(/^\.\//, '');
}

/**
 * Mark observations as stale when their dependencies have been mutated.
 */
export function invalidateObservationDependencies(
  observations: CoderObservation[] | undefined,
  filePaths: string | string[],
  round: number,
): CoderObservation[] | undefined {
  if (!observations?.length) return observations;

  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  if (paths.length === 0) return observations;
  const normalizedPaths = new Set(paths.filter(Boolean).map(normalizeObservationPath));
  if (normalizedPaths.size === 0) return observations;

  let changed = false;
  const next = observations.map((observation) => {
    if (!observation.dependsOn?.length) return observation;
    const hit = observation.dependsOn.some(dep => normalizedPaths.has(normalizeObservationPath(dep)));
    if (!hit) return observation;
    if (observation.stale && observation.staleAtRound === round) return observation;
    changed = true;
    const matchedPath = paths.find(p =>
      observation.dependsOn!.some(dep => normalizeObservationPath(dep) === normalizeObservationPath(p)),
    ) || paths[0];
    return {
      ...observation,
      stale: true,
      staleReason: `${matchedPath} was modified at round ${round}`,
      staleAtRound: round,
    };
  });

  return changed ? next : observations;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Filter observations to only those still visible (non-expired stale). */
export function getVisibleObservations(
  observations: CoderObservation[] | undefined,
  currentRound: number,
): CoderObservation[] {
  return (observations || []).filter((observation) => {
    if (!observation.stale) return true;
    const staleRound = observation.staleAtRound ?? observation.addedAtRound;
    if (typeof staleRound !== 'number') return true;
    return currentRound - staleRound <= 5;
  });
}

function formatObservationLine(observation: CoderObservation): string {
  if (observation.stale) {
    const reason = observation.staleReason || 'dependency modified';
    return `[STALE — ${reason}] ${observation.id}: ${observation.text}`;
  }
  return `${observation.id}: ${observation.text}`;
}

/** Check whether working memory has any non-empty fields. */
export function hasCoderState(mem: CoderWorkingMemory, currentRound: number): boolean {
  return Boolean(
    mem.plan
      || mem.openTasks?.length
      || mem.filesTouched?.length
      || mem.assumptions?.length
      || mem.errorsEncountered?.length
      || mem.currentPhase
      || mem.completedPhases?.length
      || getVisibleObservations(mem.observations, currentRound).length,
  );
}

/**
 * Format working memory into a [CODER_STATE] block for injection into messages.
 * Survives context trimming.
 */
export function formatCoderState(mem: CoderWorkingMemory, currentRound = 0): string {
  const lines: string[] = ['[CODER_STATE]'];
  if (mem.plan) lines.push(`Plan: ${mem.plan}`);
  if (mem.openTasks?.length) lines.push(`Open tasks: ${mem.openTasks.join('; ')}`);
  if (mem.filesTouched?.length) lines.push(`Files touched: ${mem.filesTouched.join(', ')}`);
  if (mem.assumptions?.length) lines.push(`Assumptions: ${mem.assumptions.join('; ')}`);
  if (mem.errorsEncountered?.length) lines.push(`Errors: ${mem.errorsEncountered.join('; ')}`);
  if (mem.currentPhase) lines.push(`Phase: ${mem.currentPhase}`);
  if (mem.completedPhases?.length) lines.push(`Completed: ${mem.completedPhases.join(', ')}`);
  for (const observation of getVisibleObservations(mem.observations, currentRound)) {
    lines.push(formatObservationLine(observation));
  }
  lines.push('[/CODER_STATE]');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Detection — parse coder_update_state from model output
// ---------------------------------------------------------------------------

/**
 * Detect a coder_update_state tool call in model response text.
 * Returns the parsed update or null if no valid call is found.
 */
export function detectUpdateStateCall(text: string): CoderWorkingMemoryUpdate | null {
  return detectToolFromText<CoderWorkingMemoryUpdate>(text, (parsed) => {
    const obj = asRecord(parsed);
    if (obj?.tool === 'coder_update_state') {
      const args = asRecord(obj.args) || obj;
      const state: CoderWorkingMemoryUpdate = {};
      if (typeof args.plan === 'string') state.plan = args.plan;
      if (Array.isArray(args.openTasks)) state.openTasks = (args.openTasks as unknown[]).filter((v): v is string => typeof v === 'string');
      if (Array.isArray(args.filesTouched)) state.filesTouched = (args.filesTouched as unknown[]).filter((v): v is string => typeof v === 'string');
      if (Array.isArray(args.assumptions)) state.assumptions = (args.assumptions as unknown[]).filter((v): v is string => typeof v === 'string');
      if (Array.isArray(args.errorsEncountered)) state.errorsEncountered = (args.errorsEncountered as unknown[]).filter((v): v is string => typeof v === 'string');
      if (typeof args.currentPhase === 'string') state.currentPhase = args.currentPhase;
      if (Array.isArray(args.completedPhases)) state.completedPhases = (args.completedPhases as unknown[]).filter((v): v is string => typeof v === 'string');
      if (Array.isArray(args.observations)) {
        const observations: CoderObservationUpdate[] = [];
        for (const entry of args.observations as unknown[]) {
          const obs = asRecord(entry);
          if (!obs) continue;
          const id = typeof obs.id === 'string' ? obs.id.trim() : '';
          if (!id) continue;
          if (obs.remove === true) {
            observations.push({ id, remove: true });
            continue;
          }
          if (typeof obs.text !== 'string') continue;
          const dependsOn = Array.isArray(obs.dependsOn)
            ? (obs.dependsOn as unknown[]).filter((value): value is string => typeof value === 'string')
            : undefined;
          observations.push({ id, text: obs.text, dependsOn });
        }
        if (observations.length) state.observations = observations;
      }
      if (Object.keys(state).length === 0) return null;
      return state;
    }
    return null;
  });
}
