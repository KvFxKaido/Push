import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import { safeStorageGet } from './safe-storage';

const DEFAULT_SERVICE_NAME = 'push-web';
const STORAGE_KEYS = {
  enabled: 'push:otel:enabled',
  endpoint: 'push:otel:endpoint',
  console: 'push:otel:console',
  serviceName: 'push:otel:service-name',
} as const;

export interface PushTracingConfig {
  enabled: boolean;
  endpoint: string | null;
  consoleExporter: boolean;
  serviceName: string;
  environment: string;
}

type TracingEnvInput = {
  DEV?: boolean;
  MODE?: string;
  VITE_OTEL_ENABLED?: string | boolean;
  VITE_OTEL_CONSOLE?: string | boolean;
  VITE_OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  VITE_OTEL_SERVICE_NAME?: string;
};

let initialized = false;
let cachedConfig: PushTracingConfig | null = null;

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseBoolean(value: string | boolean | null | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function readStorageValue(key: string): string | null {
  return safeStorageGet(key);
}

export function resolveTracingConfigFromInputs(
  env: TracingEnvInput = import.meta.env,
  storageGet: (key: string) => string | null = readStorageValue,
): PushTracingConfig {
  const explicitEnabled = parseBoolean(storageGet(STORAGE_KEYS.enabled)) ?? parseBoolean(env.VITE_OTEL_ENABLED);
  const endpoint = normalizeString(storageGet(STORAGE_KEYS.endpoint))
    || normalizeString(env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT)
    || null;
  const consoleExporter = parseBoolean(storageGet(STORAGE_KEYS.console))
    ?? parseBoolean(env.VITE_OTEL_CONSOLE)
    ?? false;
  const serviceName = normalizeString(storageGet(STORAGE_KEYS.serviceName))
    || normalizeString(env.VITE_OTEL_SERVICE_NAME)
    || DEFAULT_SERVICE_NAME;
  const environment = normalizeString(env.MODE)
    || (env.DEV ? 'development' : 'production');

  return {
    enabled: explicitEnabled ?? Boolean(endpoint || consoleExporter),
    endpoint,
    consoleExporter,
    serviceName,
    environment,
  };
}

export function initPushTracing(): PushTracingConfig {
  if (initialized) {
    return cachedConfig || resolveTracingConfigFromInputs();
  }
  initialized = true;

  const config = resolveTracingConfigFromInputs();
  cachedConfig = config;
  if (!config.enabled) return config;

  const spanProcessors = [];
  if (config.endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: config.endpoint })),
    );
  }
  if (config.consoleExporter) {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }
  if (spanProcessors.length === 0) return config;

  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        'service.name': config.serviceName,
        'deployment.environment.name': config.environment,
      }),
      spanProcessors,
    });
    provider.register({
      contextManager: new StackContextManager(),
      propagator: new W3CTraceContextPropagator(),
    });
  } catch (error) {
    console.warn(
      '[tracing] Failed to initialize OpenTelemetry tracing:',
      error instanceof Error ? error.message : String(error),
    );
  }

  return config;
}

export function getPushTracer(scope = 'push.runtime') {
  return trace.getTracer(scope);
}

export function setSpanAttributes(span: Span, attributes: Attributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    span.setAttribute(key, value);
  }
}

export function recordSpanError(
  span: Span,
  error: unknown,
  attributes?: Attributes,
): void {
  if (attributes) setSpanAttributes(span, attributes);

  const isAbort = error instanceof DOMException && error.name === 'AbortError';
  if (isAbort) {
    span.setAttribute('push.cancelled', true);
    return;
  }

  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

export async function withActiveSpan<T>(
  name: string,
  options: {
    scope?: string;
    kind?: SpanKind;
    attributes?: Attributes;
  },
  fn: (span: Span, spanContext: Context) => Promise<T>,
): Promise<T> {
  const tracer = getPushTracer(options.scope);
  return tracer.startActiveSpan(
    name,
    {
      kind: options.kind,
      attributes: options.attributes,
    },
    async (span) => {
      const spanContext = trace.setSpan(context.active(), span);
      try {
        return await fn(span, spanContext);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function injectTraceHeaders(
  headers: Record<string, string>,
  traceContext: Context = context.active(),
): Record<string, string> {
  propagation.inject(traceContext, headers);
  return headers;
}

export { SpanKind, SpanStatusCode };
