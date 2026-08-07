/**
 * Internal run-state types. The types workflow authors touch live in
 * `public-types.ts`, which is copied into projects verbatim; they're re-exported
 * here so runtime modules have one import site.
 */

export type {
  AgentRecord,
  AgentStatus,
  ModelParameterValue,
  ModelSelection,
  WorkflowAgentOptions,
  WorkflowContext,
  WorkflowMeta,
  WorkflowModule,
} from "./public-types.js";

import type { AgentRecord } from "./public-types.js";

export type RunStatus = "running" | "finished" | "error" | "stopped";

export interface PhaseRecord {
  name: string;
  startedAt: number;
  endedAt?: number;
}

/** Maintained incrementally by RunStore; never recomputed by walking agents. */
export interface RunTotals {
  agents: number;
  pending: number;
  running: number;
  finished: number;
  cached: number;
  errored: number;
  tokens: number;
}

export interface RunState {
  runId: string;
  workflow: string;
  description?: string;
  cwd: string;
  /** Absolute path to the workflow script, so a run can be relaunched. */
  file: string;
  /** Original argv tail, replayed verbatim on resume. */
  argv: string[];
  /** Runner pid, so the management surface can stop a live run. */
  pid: number;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  args?: unknown;
  concurrency: number;
  agentCap: number;
  phases: PhaseRecord[];
  agents: AgentRecord[];
  totals: RunTotals;
  /** Live HTTP dashboard, when the server view is enabled. */
  viewUrl?: string;
  /** Absolute path to the emitted canvas, once the run finishes. */
  canvasPath?: string;
  error?: string;
}
