/**
 * Lightweight performance instrumentation for Push web surfaces.
 *
 * Uses the browser Performance API (mark + measure) so timings show up in
 * DevTools → Performance and can be collected by any RUM pipeline without
 * adding runtime overhead when nobody is listening.
 *
 * Usage:
 *   perfMark('chat:open');           // start point
 *   perfMeasure('chat:open', 'chat:ready');  // measure from open→ready
 *
 * All marks are prefixed with "push:" for easy filtering.
 */

const PREFIX = 'push:';

function prefixed(name: string): string {
  return name.startsWith(PREFIX) ? name : `${PREFIX}${name}`;
}

/** Drop a high-resolution timestamp mark. */
export function perfMark(name: string): void {
  try {
    performance.mark(prefixed(name));
  } catch {
    // Silently ignore in environments where Performance API is unavailable.
  }
}

/**
 * Measure the duration between two marks.
 * Logs to console in development and keeps the entry available for
 * PerformanceObserver consumers.
 */
export function perfMeasure(startMark: string, endMark?: string): PerformanceMeasure | null {
  const start = prefixed(startMark);
  const end = endMark ? prefixed(endMark) : undefined;
  try {
    // If no end mark, measure from start mark to now.
    const measure = end
      ? performance.measure(`${start} → ${end}`, start, end)
      : performance.measure(`${start} → now`, start);

    if (import.meta.env.DEV) {
      console.debug(`[perf] ${measure.name}: ${measure.duration.toFixed(1)}ms`);
    }
    return measure;
  } catch {
    return null;
  }
}

/**
 * Convenience: mark start, return a function that marks end and measures.
 * Useful for wrapping a render or async operation.
 *
 *   const done = perfStart('workspace:open');
 *   // ...work...
 *   done(); // logs duration
 */
export function perfStart(name: string): () => PerformanceMeasure | null {
  const markName = prefixed(name);
  try {
    performance.mark(markName);
  } catch {
    return () => null;
  }
  return () => {
    const endName = `${markName}:end`;
    try {
      performance.mark(endName);
      const measure = performance.measure(`${markName}`, markName, endName);
      if (import.meta.env.DEV) {
        console.debug(`[perf] ${name}: ${measure.duration.toFixed(1)}ms`);
      }
      return measure;
    } catch {
      return null;
    }
  };
}
