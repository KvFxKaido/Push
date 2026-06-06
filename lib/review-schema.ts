/**
 * review-schema.ts — Canonical zod schema for the JSON a reviewer model emits.
 *
 * Single source of truth for the `{ summary, comments[] }` payload shape that
 * both the advisory reviewer (`reviewer-agent.ts`) and the deep reviewer
 * (`deep-reviewer-agent.ts`) ask the model to produce. The two sites had
 * byte-for-byte copies of the same fence-strip + `JSON.parse` + hand-rolled
 * type-guard mapping; pinning the shape here keeps them from drifting (the
 * "one source of truth per vocabulary" rule).
 *
 * Defaults are encoded with zod `.catch` so the schema reproduces the inline
 * coercion the call sites used to do — adopting it is behaviour-preserving.
 *
 * Consumed via `parseStructured` (see `structured-output.ts`).
 */

import { z } from 'zod';
import type { ReviewComment } from './provider-contract.js';

/** One review finding. Mirrors `ReviewComment` from provider-contract. */
export const ReviewCommentSchema = z
  .object({
    file: z.string().catch('unknown'),
    severity: z.enum(['critical', 'warning', 'suggestion', 'note']).catch('note'),
    comment: z.string().catch(''),
    // Keep a line number only when it's a positive integer; otherwise omit
    // the field entirely (the old code spread `...(line !== undefined ...)`).
    line: z.number().int().positive().optional().catch(undefined),
  })
  .catch({ file: 'unknown', severity: 'note', comment: '', line: undefined })
  .transform(
    (c): ReviewComment => ({
      file: c.file,
      severity: c.severity,
      comment: c.comment,
      ...(c.line !== undefined ? { line: c.line } : {}),
    }),
  );

/** The full reviewer response: a summary plus zero or more findings. */
export const ReviewerResponseSchema = z
  .object({
    summary: z.string().catch('No summary provided.'),
    comments: z
      .array(ReviewCommentSchema)
      .catch([])
      .transform((cs) => cs.filter((c) => c.comment.length > 0)),
  })
  // Valid JSON that isn't an object (a bare primitive) coerces to an empty
  // review rather than failing the schema, so only genuinely unparseable
  // JSON reaches a caller's failure branch.
  .catch({ summary: 'No summary provided.', comments: [] });
