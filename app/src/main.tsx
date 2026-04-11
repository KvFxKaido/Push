import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { initPushTracing } from './lib/tracing.ts';
import { perfMark } from './lib/perf-marks.ts';

perfMark('app:boot');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found in index.html');
}

initPushTracing();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

perfMark('app:render-scheduled');
