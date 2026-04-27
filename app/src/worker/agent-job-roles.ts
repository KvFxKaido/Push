/**
 * Tiny shared module for the AgentJob role registry. Lives here, not
 * in `coder-job-do.ts`, so the route handler (`worker-coder-job.ts`)
 * can validate roles without pulling the DO's full transitive import
 * graph (Cloudflare Sandbox, container runtime, kernel libs) into its
 * test module graph. Keeping this file dependency-free except for the
 * shared `AgentRole` type means any module — runtime or test — can
 * import it cheaply.
 */

import type { AgentRole } from '@push/lib/runtime-contract';

/** Roles the AgentJob runtime knows how to dispatch. PR 1 wires only
 *  `'coder'`; the route layer + DO both reject other roles with
 *  `UNSUPPORTED_ROLE`. New roles join here as their kernels are
 *  migrated off the in-browser foreground loop. */
export const SUPPORTED_AGENT_JOB_ROLES: ReadonlySet<AgentRole> = new Set(['coder']);
