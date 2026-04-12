/**
 * Re-export from shared lib — canonical comment checker lives in
 * lib/comment-check.ts. Web app consumers import from '@/lib/comment-check'
 * unchanged.
 */
export { detectAiCommentPatterns, formatCommentCheckBlock } from '@push/lib/comment-check';

export type {
  CommentCheckKind,
  CommentCheckOptions,
  CommentFinding,
} from '@push/lib/comment-check';
