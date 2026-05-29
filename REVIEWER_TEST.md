# Reviewer smoke test

Throwaway PR to verify the autonomous reviewer produces a review with the
configured model. Safe to close without merging.

## Sample change for the reviewer to chew on

```ts
export function clampRetries(n: number): number {
  // intentionally naive — gives the reviewer something to comment on
  return n > 5 ? 5 : n;
}
```
