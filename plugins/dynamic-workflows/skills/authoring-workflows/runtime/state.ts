/**
 * Run state: an append-only JSONL event log plus a `state.json` snapshot.
 *
 * The log is the source of truth; the snapshot exists so the management
 * surface and the HTTP view can read a run without replaying every event.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDir } from "./paths.js";
import type {
  AgentRecord,
  AgentStatus,
  PhaseRecord,
  RunState,
  RunStatus,
} from "./types.js";

const SNAPSHOT_DEBOUNCE_MS = 250;

/** Which counter in `RunTotals` a status contributes to. */
type TotalsBucket = "pending" | "running" | "finished" | "cached" | "errored";

function bucketOf(status: AgentStatus): TotalsBucket {
  switch (status) {
    case "running":
      return "running";
    case "finished":
      return "finished";
    case "cached":
      return "cached";
    case "error":
    case "cancelled":
      return "errored";
    default:
      return "pending";
  }
}

export class RunStore {
  readonly dir: string;
  private readonly eventsPath: string;
  private readonly statePath: string;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private listeners: Array<(state: RunState) => void> = [];

  constructor(private state: RunState) {
    this.dir = runDir(state.runId);
    mkdirSync(this.dir, { recursive: true });
    this.eventsPath = join(this.dir, "events.jsonl");
    this.statePath = join(this.dir, "state.json");
    this.append("run_started", { workflow: state.workflow, args: state.args });
    this.flush();
  }

  get snapshot(): RunState {
    return this.state;
  }

  onChange(listener: (state: RunState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private append(type: string, payload: unknown): void {
    appendFileSync(
      this.eventsPath,
      JSON.stringify({ t: Date.now(), type, ...(payload as object) }) + "\n"
    );
  }

  /** Writes the snapshot and notifies view listeners. */
  private touch(): void {
    for (const listener of this.listeners) listener(this.state);

    if (this.snapshotTimer !== undefined) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.flush();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  flush(): void {
    if (this.snapshotTimer !== undefined) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  startPhase(name: string): PhaseRecord {
    const phase: PhaseRecord = { name, startedAt: Date.now() };
    this.state.phases.push(phase);
    this.append("phase_started", { name });
    this.touch();
    return phase;
  }

  endPhase(phase: PhaseRecord): void {
    phase.endedAt = Date.now();
    this.append("phase_ended", { name: phase.name });
    this.touch();
  }

  addAgent(record: Omit<AgentRecord, "id" | "tokens" | "status">): AgentRecord {
    const agent: AgentRecord = {
      ...record,
      id: this.state.agents.length + 1,
      status: "pending",
      tokens: 0,
    };
    this.state.agents.push(agent);
    this.state.totals.agents += 1;
    this.state.totals.pending += 1;
    this.append("agent_added", {
      id: agent.id,
      label: agent.label,
      phase: agent.phase,
      hash: agent.hash,
    });
    this.touch();
    return agent;
  }

  updateAgent(
    agent: AgentRecord,
    status: AgentStatus,
    patch: Partial<AgentRecord> = {}
  ): void {
    // Totals are maintained incrementally. Recomputing them by walking every
    // agent on each transition is O(n) per update and O(n^2) over a run, which
    // is felt on the several-hundred-agent runs this is built for.
    const totals = this.state.totals;
    totals[bucketOf(agent.status)] -= 1;
    totals.tokens -= agent.tokens;

    Object.assign(agent, patch, { status });
    if (status === "running") agent.startedAt = Date.now();
    else if (status !== "pending") agent.endedAt = Date.now();

    totals[bucketOf(status)] += 1;
    totals.tokens += agent.tokens;

    this.append("agent_" + status, { id: agent.id, ...patch });
    this.touch();
  }

  setViewUrl(url: string): void {
    this.state.viewUrl = url;
    this.touch();
  }

  setCanvasPath(path: string): void {
    this.state.canvasPath = path;
    this.touch();
  }

  finish(status: RunStatus, error?: string): void {
    this.state.status = status;
    this.state.endedAt = Date.now();
    if (error !== undefined) this.state.error = error;
    this.append("run_" + status, { error });
    this.touch();
    this.flush();
  }
}

export function readRunState(runId: string): RunState | undefined {
  try {
    return JSON.parse(
      readFileSync(join(runDir(runId), "state.json"), "utf8")
    ) as RunState;
  } catch {
    return undefined;
  }
}
