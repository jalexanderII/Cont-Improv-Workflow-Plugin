/**
 * Public surface for workflow scripts.
 *
 * Scripts don't import these helpers: the runner injects them as the single
 * argument to the script's default export. That keeps generated workflows free
 * of any path resolution back into the plugin, so they stay portable and
 * survive the plugin moving or being reinstalled elsewhere.
 */

export type {
  AgentRecord,
  AgentStatus,
  WorkflowAgentOptions,
  WorkflowContext,
  WorkflowMeta,
  WorkflowModule,
} from "./public-types.js";

export type { RunState } from "./types.js";
