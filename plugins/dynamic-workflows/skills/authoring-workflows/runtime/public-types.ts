/**
 * The public workflow-authoring types.
 *
 * This file has no imports on purpose: `bootstrap.sh` copies it verbatim into a
 * project's `.cursor/workflows/_runtime.ts`, so generated workflow scripts get
 * full editor types without any path pointing back at the plugin. Keep it
 * self-contained, or that copy breaks.
 */

export type AgentStatus =
  | "pending"
  | "running"
  | "finished"
  | "cached"
  | "error"
  | "cancelled";

/** One model parameter, e.g. `{ id: "effort", value: "high" }`. */
export interface ModelParameterValue {
  id: string;
  value: string;
}

/**
 * A model the way the SDK selects one: a catalog id plus optional parameters.
 *
 * Effort and speed are parameters, **not** part of the id. Grok at high effort
 * with fast enabled is `{ id: "grok-4.5", params: [{ id: "effort", value:
 * "high" }, { id: "fast", value: "true" }] }`. Strings like
 * `cursor-grok-4.5-high-fast` are UI slugs, not catalog ids, and are rejected.
 *
 * Omit `params` to let the model's own default variant apply.
 */
export interface ModelSelection {
  id: string;
  params?: ModelParameterValue[];
}

export interface AgentRecord {
  /** Monotonic per-run id, also the replay order. */
  id: number;
  label: string;
  phase: string;
  status: AgentStatus;
  /**
   * Content address of the call: prompt + model selection (id and parameters) +
   * tool posture + cwd.
   */
  hash: string;
  /** Display form, e.g. `grok-4.5 (effort=high, fast=true)`. */
  model?: string;
  readOnly: boolean;
  startedAt?: number;
  endedAt?: number;
  tokens: number;
  /** Truncated result text, for the progress views. */
  preview?: string;
  error?: string;
  /**
   * SDK run id, which is the handle to this agent's full transcript. The SDK
   * persists every turn locally; without the id there is no way back to it, so
   * it is recorded even when the agent fails — a failed agent's transcript is
   * the one most worth reading.
   */
  runId?: string;
  /**
   * Only set when the agent overrode the run's working directory. The local
   * agent store is scoped by workspace, so reading a transcript back needs the
   * cwd the agent actually ran in.
   */
  cwd?: string;
  /**
   * The transcript existed and retention removed it. Distinguishes an expired
   * transcript from one that never existed, such as a dry run's.
   */
  transcriptPruned?: boolean;
}

/** Options accepted by `agent()` inside a workflow script. */
export interface WorkflowAgentOptions {
  /** Shown in every progress view. Defaults to a truncated prompt. */
  label?: string;
  /** Groups the agent under a phase in the views. */
  phase?: string;
  /**
   * Overrides the run's model for this one agent. A bare string is the catalog
   * id; the object form carries parameters too.
   *
   * @example
   * { model: { id: "grok-4.5", params: [{ id: "effort", value: "high" }] } }
   */
  model?: string | ModelSelection;
  /**
   * Parameters to go with a string `model`. Equivalent to the object form; when
   * both are given, the object's own `params` wins.
   *
   * @example
   * { model: "grok-4.5", modelParams: [{ id: "effort", value: "low" }] }
   */
  modelParams?: ModelParameterValue[];
  /**
   * Drops `edit` and `shell` from the worker's toolset. Read, grep, glob, ls,
   * and web tools stay available. Use for audit, review, and research phases.
   */
  readOnly?: boolean;
  /** Explicit allowlist. Takes precedence over `readOnly`. */
  tools?: string[];
  /** Explicit denylist, merged with the `readOnly` denials. */
  disallowedTools?: string[];
  /** Defaults to the run's cwd. Point at a worktree to isolate edits. */
  cwd?: string;
  /** Set false to always re-run this agent, even on resume. */
  cache?: boolean;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
  /** Advisory ceiling the author aims for; not enforced. */
  size?: "small" | "medium" | "large" | "unrestricted";
}

/**
 * Injected by the runner as the single argument to a workflow's default export.
 * Scripts never import these helpers, so they stay portable.
 */
export interface WorkflowContext<Args = unknown> {
  /**
   * Spawns one subagent and resolves to its final text, or `null` if it failed.
   *
   * @example
   * const summary = await agent("Summarize src/auth.ts", { readOnly: true });
   */
  agent: (
    prompt: string,
    options?: WorkflowAgentOptions
  ) => Promise<string | null>;

  /**
   * Spawns one subagent and parses its reply against a JSON Schema.
   * Resolves to `null` if the agent failed or returned unparseable output.
   */
  agentJSON: <T>(
    prompt: string,
    schema: object,
    options?: WorkflowAgentOptions
  ) => Promise<T | null>;

  /**
   * Runs `fn` once per item, bounded by the run's concurrency, preserving
   * input order. Failed agents surface as `null`.
   *
   * @example
   * const results = await pipeline(files, f => agent(`Audit ${f}`, { label: f }));
   * return results.filter(Boolean);
   */
  pipeline: <T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>
  ) => Promise<R[]>;

  /** Groups everything spawned inside the callback under a named phase. */
  phase: <T>(name: string, fn: () => Promise<T>) => Promise<T>;

  /** Whatever was passed at invocation time; `undefined` when omitted. */
  args: Args;

  /**
   * True when every agent is stubbed. Agents cost nothing in this mode, but
   * anything the *script itself* does still really happens — so guard shell
   * commands, git operations, and file writes in the script body with this.
   */
  dryRun: boolean;

  /** Agent records so far, for scripts that report on their own run. */
  runAgents: () => readonly AgentRecord[];
}

/** The shape a workflow script must export. */
export interface WorkflowModule<Args = unknown> {
  meta?: WorkflowMeta;
  default: (ctx: WorkflowContext<Args>) => Promise<unknown>;
}
