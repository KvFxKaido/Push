import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useIsMobile } from './use-mobile';

interface UseExpandableOptions {
  collapseOnMobile?: boolean;
}

function getInitialExpanded(defaultExpanded: boolean, collapseOnMobile: boolean): boolean {
  if (!defaultExpanded) return false;
  if (!collapseOnMobile || typeof window === 'undefined') return defaultExpanded;
  return !window.matchMedia('(max-width: 767px)').matches;
}

export function useExpandable(defaultExpanded = false, options: UseExpandableOptions = {}) {
  const { collapseOnMobile = false } = options;
  const isMobile = useIsMobile();
  const [expanded, setExpandedState] = useState(() => getInitialExpanded(defaultExpanded, collapseOnMobile));
  const hasUserInteractedRef = useRef(false);
  const previousIsMobileRef = useRef(isMobile);

  useEffect(() => {
    if (!collapseOnMobile) {
      previousIsMobileRef.current = isMobile;
      return;
    }

    const wasMobile = previousIsMobileRef.current;
    previousIsMobileRef.current = isMobile;

    if (hasUserInteractedRef.current) return;
    if (isMobile && !wasMobile) {
      const collapseTimer = window.setTimeout(() => setExpandedState(false), 0);
      return () => window.clearTimeout(collapseTimer);
    }
  }, [collapseOnMobile, isMobile]);

  const setExpanded = useCallback((value: SetStateAction<boolean>) => {
    hasUserInteractedRef.current = true;
    setExpandedState(value);
  }, []);

  const toggleExpanded = useCallback(() => {
    hasUserInteractedRef.current = true;
    setExpandedState((prev) => !prev);
  }, []);

  return { expanded, setExpanded, toggleExpanded };
}
