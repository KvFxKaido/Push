import { describe, expect, it } from 'vitest';
import { resolveTracingConfigFromInputs } from './tracing';

describe('resolveTracingConfigFromInputs', () => {
  it('stays disabled when no exporter is configured', () => {
    const config = resolveTracingConfigFromInputs({ DEV: false, MODE: 'production' }, () => null);

    expect(config).toEqual({
      enabled: false,
      endpoint: null,
      consoleExporter: false,
      serviceName: 'push-web',
      environment: 'production',
    });
  });

  it('enables OTLP export from env config', () => {
    const config = resolveTracingConfigFromInputs(
      {
        DEV: true,
        MODE: 'development',
        VITE_OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test/v1/traces',
        VITE_OTEL_SERVICE_NAME: 'push-dev',
      },
      () => null,
    );

    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe('https://otel.example.test/v1/traces');
    expect(config.consoleExporter).toBe(false);
    expect(config.serviceName).toBe('push-dev');
    expect(config.environment).toBe('development');
  });

  it('lets storage override env config', () => {
    const storage: Record<string, string> = {
      'push:otel:endpoint': 'https://collector.internal/v1/traces',
      'push:otel:console': '1',
      'push:otel:service-name': 'push-local',
    };
    const config = resolveTracingConfigFromInputs(
      {
        DEV: false,
        MODE: 'production',
        VITE_OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test/v1/traces',
        VITE_OTEL_SERVICE_NAME: 'push-prod',
      },
      (key) => storage[key] ?? null,
    );

    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe('https://collector.internal/v1/traces');
    expect(config.consoleExporter).toBe(true);
    expect(config.serviceName).toBe('push-local');
  });

  it('honors explicit disable even when exporters are configured', () => {
    const storage: Record<string, string> = {
      'push:otel:enabled': '0',
      'push:otel:endpoint': 'https://collector.internal/v1/traces',
      'push:otel:console': '1',
    };
    const config = resolveTracingConfigFromInputs(
      { DEV: true, MODE: 'development' },
      (key) => storage[key] ?? null,
    );

    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBe('https://collector.internal/v1/traces');
    expect(config.consoleExporter).toBe(true);
  });
});
