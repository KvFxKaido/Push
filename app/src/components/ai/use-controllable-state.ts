import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Controlled/uncontrolled state helper, folded in rather than pulling
 * `@radix-ui/react-use-controllable-state` (a ~15-line hook) as a dependency.
 * Matches Radix's contract: the setter accepts a value or an updater and only
 * fires `onChange` when the resolved value actually changes.
 *
 * Shared by the `ai/` primitives (ChainOfThought, Reasoning).
 */
export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T;
  defaultProp: T;
  onChange?: (value: T) => void;
}): [T, (next: T | ((prev: T) => T)) => void] {
  const [uncontrolled, setUncontrolled] = useState<T>(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? (prop as T) : uncontrolled;

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolve = (prev: T): T =>
        typeof next === 'function' ? (next as (p: T) => T)(prev) : next;

      if (isControlled) {
        const nextValue = resolve(prop as T);
        if (nextValue !== prop) {
          onChangeRef.current?.(nextValue);
        }
        return;
      }

      setUncontrolled((prev) => {
        const nextValue = resolve(prev);
        if (nextValue !== prev) {
          onChangeRef.current?.(nextValue);
        }
        return nextValue;
      });
    },
    [isControlled, prop],
  );

  return [value, setValue];
}
