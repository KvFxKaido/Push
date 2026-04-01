import { useEffect, useRef } from 'react';
import { perfMark, perfMeasure } from '@/lib/perf-marks';

/**
 * Marks when a surface mounts (first paint) and optionally measures from
 * a prior mark. Fires once on mount only.
 *
 * Example:
 *   usePerfMark('chat:painted', 'screen:workspace');
 *   // → logs "push:screen:workspace → push:chat:painted: 142.3ms"
 */
export function usePerfMark(name: string, measureFrom?: string): void {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    perfMark(name);
    if (measureFrom) {
      perfMeasure(measureFrom, name);
    }
  }, [name, measureFrom]);
}
