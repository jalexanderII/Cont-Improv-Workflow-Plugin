/** Filesystem layout for the runtime. Everything lives outside the user's repo. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = join(homedir(), ".cursor", "workflows-runtime");
export const RUNS_DIR = join(ROOT, "runs");
export const DEPS_DIR = join(ROOT, "deps");

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

/**
 * Agent results are cached per run, not per workflow.
 *
 * A shared cache keyed only on prompt content makes re-running the same
 * workflow a no-op: every agent hits the cache and the "run" finishes in
 * milliseconds replaying stale answers. That is right for resuming an
 * interrupted run and wrong for starting a new one, so `wf resume` continues
 * under the original run id and reads this directory, while a fresh run starts
 * with an empty one.
 */
export function runCacheDir(runId: string): string {
  return join(runDir(runId), "cache");
}

/**
 * Canvases are only picked up from the IDE's managed directory for the
 * workspace, which is keyed by the workspace path with separators flattened.
 */
export function canvasDirFor(workspacePath: string): string {
  const slug = resolve(workspacePath).replace(/^\//, "").replace(/\//g, "-");
  return join(homedir(), ".cursor", "projects", slug, "canvases");
}
