import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { RootErrorBoundary } from './components/RootErrorBoundary.tsx';
import { initPushTracing } from './lib/tracing.ts';
import { installGlobalErrorHandlers } from './lib/error-reporting.ts';
import { perfMark } from './lib/perf-marks.ts';

perfMark('app:boot');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

const tracingConfig = initPushTracing();
// Global error capture is gated on tracing being enabled — when there's no
// exporter configured, there's nowhere for crash events to go.
if (tracingConfig.enabled) {
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
