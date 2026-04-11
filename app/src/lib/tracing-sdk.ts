/**
 * Heavy OpenTelemetry SDK imports, loaded lazily by tracing.ts only when
 * tracing is actually enabled. This keeps the critical-path bundle lean.
 */
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
import type { PushTracingConfig } from './tracing';

export function bootstrapTracing(config: PushTracingConfig): void {
  const spanProcessors = [];
  if (config.endpoint) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: config.endpoint })));
  }
  if (config.consoleExporter) {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }
  if (spanProcessors.length === 0) return;

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
}
