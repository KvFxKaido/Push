/**
 * Pure, surface-neutral configuration layering.
 *
 * Callers provide layers from lowest to highest precedence. Objects merge
 * recursively, while arrays and scalar values replace the previous value.
 * Every resolved leaf keeps its winning source so operator-facing commands can
 * explain behavior without re-deriving precedence from runtime branches.
 */

export type ConfigObject = Record<string, unknown>;

export type ConfigLayerKind =
  | 'defaults'
  | 'managed'
  | 'user'
  | 'profile'
  | 'project'
  | 'environment'
  | 'cli';

export interface ConfigLayer<TConfig extends ConfigObject = ConfigObject> {
  /** Stable, human-readable source id (for example `env:PUSH_PROVIDER`). */
  id: string;
  kind: ConfigLayerKind;
  /** Optional filesystem path for file-backed layers. */
  path?: string;
  value: Partial<TConfig>;
}

export interface ConfigOrigin {
  source: string;
  kind: ConfigLayerKind;
  path?: string;
}

export interface ConfigResolution<TConfig extends ConfigObject = ConfigObject> {
  config: TConfig;
  /** Winning source keyed by dotted config path. Values are never included. */
  provenance: Record<string, ConfigOrigin>;
  /** Applied layer order, lowest to highest precedence. */
  layers: Array<Omit<ConfigLayer, 'value'>>;
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value: unknown): value is ConfigObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneConfigValue(child)]),
  );
}

function clearProvenanceBranch(provenance: Record<string, ConfigOrigin>, path: string): void {
  for (const key of Object.keys(provenance)) {
    if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
  }
}

function mergeObject(
  target: ConfigObject,
  incoming: ConfigObject,
  origin: ConfigOrigin,
  provenance: Record<string, ConfigOrigin>,
  parentPath = '',
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new Error(`Unsafe configuration key: ${parentPath ? `${parentPath}.` : ''}${key}`);
    }
    const configPath = parentPath ? `${parentPath}.${key}` : key;

    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        target[key] = {};
        clearProvenanceBranch(provenance, configPath);
      }
      mergeObject(target[key] as ConfigObject, value, origin, provenance, configPath);
      continue;
    }

    target[key] = cloneConfigValue(value);
    clearProvenanceBranch(provenance, configPath);
    provenance[configPath] = origin;
  }
}

export function mergeConfigLayers<TConfig extends ConfigObject>(
  layers: ReadonlyArray<ConfigLayer<TConfig>>,
): ConfigResolution<TConfig> {
  const config: ConfigObject = {};
  const provenance: Record<string, ConfigOrigin> = {};

  for (const layer of layers) {
    const origin: ConfigOrigin = {
      source: layer.id,
      kind: layer.kind,
      ...(layer.path ? { path: layer.path } : {}),
    };
    mergeObject(config, layer.value, origin, provenance);
  }

  return {
    config: config as TConfig,
    provenance,
    layers: layers.map(({ id, kind, path }) => ({
      id,
      kind,
      ...(path ? { path } : {}),
    })),
  };
}
