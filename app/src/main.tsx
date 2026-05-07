import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { RootErrorBoundary } from './components/RootErrorBoundary.tsx';
import { initPushTracing } from './lib/tracing.ts';
import { installGlobalErrorHandlers, primeErrorReporting } from './lib/error-reporting.ts';
import { perfMark } from './lib/perf-marks.ts';
import { installDeploymentAuthFetch } from './lib/deployment-auth.ts';

perfMark('app:boot');
installDeploymentAuthFetch();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

const tracingConfig = initPushTracing();
// Global error capture is gated on tracing being enabled AND at least one
// exporter being configured. `initPushTracing` returns `enabled: true` as
// long as the user explicitly opted in, but it skips SDK bootstrap when no
// endpoint or console exporter is set — in that case the tracer stays a
// no-op and `reportError` spans would be silently dropped. Match the same
// bootstrap guard here so handlers are only installed when crash events can
// actually be exported.
if (tracingConfig.enabled && (tracingConfig.endpoint || tracingConfig.consoleExporter)) {
  // Prime the reporter to buffer crashes during the pre-bootstrap window —
  // `initPushTracing` defers SDK setup to `requestIdleCallback` for first
  // paint, and we don't want to drop early-startup errors on the floor while
  // we wait for the tracer to come up.
  primeErrorReporting();
  installGlobalErrorHandlers();
}

createRoot(rootElement).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

perfMark('app:render-scheduled');

// Service-worker registration. Lives here (not as an inline <script> in
// index.html) so the page can ship a strict `script-src 'self'` CSP without
// `'unsafe-inline'`. Bundled by Vite, served same-origin from a stable
// /sw.js path so the browser can detect updates on each load.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failures shouldn't block app boot. The PWA shell stays
      // functional without the SW; offline cache is the only thing missing.
    });
  });
}
