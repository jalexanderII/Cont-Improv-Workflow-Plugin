/**
 * Subagent transcripts: reading them back, and not letting them pile up.
 *
 * The SDK already persists every turn of every local agent under
 * `~/.cursor/projects/<workspace>/sdk-agent-store/`. A workflow agent's run id
 * is the handle to its entry, so `AgentRecord.runId` is all the progress views
 * need to show what a subagent actually did.
 *
 * That store is shared with anything else using the SDK in the same workspace,
 * so pruning is deliberately narrow: only agents this runtime recorded a run id
 * for are ever deleted, and only through the SDK, which keeps its index and the
 * per-agent blob directories consistent. Agents created by other tools are not
 * ours to remove.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { agentStoreDirFor, DEPS_DIR, LAST_PRUNE_FILE, ROOT, RUNS_DIR } from "./paths.js";
import { readRunState, writeRunState } from "./state.js";
import type { AgentRecord, RunState } from "./types.js";

/**
 * How long a transcript survives before automatic pruning removes it.
 *
 * Seven days rather than the thirty Claude Code keeps: a fan-out run makes tens
 * of transcripts at once and they are megabytes each, so a month of them is
 * gigabytes of a user's disk for output nobody has opened in weeks.
 */
export const DEFAULT_TTL_DAYS = 7;

/** At most one automatic prune a day; the explicit command is always allowed. */
const AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

// --- SDK access -------------------------------------------------------------

interface SdkRunHandle {
  id: string;
  agentId: string;
  status: string;
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  durationMs?: number;
  usage?: Record<string, number>;
  supports(operation: string): boolean;
  conversation(): Promise<RawTurn[]>;
}

interface SdkAgentApi {
  getRun(
    runId: string,
    options: { runtime: "local"; cwd: string }
  ): Promise<SdkRunHandle>;
  delete(agentId: string, options: { cwd: string }): Promise<void>;
  messages: {
    list(
      agentId: string,
      options: { runtime: "local"; cwd: string; limit?: number }
    ): Promise<Array<{ type: string; message?: unknown }>>;
  };
}

/**
 * Loads @cursor/sdk from the runtime's own dependency directory, the same way
 * `run.ts` does, so reading a transcript never depends on the project having
 * the SDK installed.
 */
/**
 * The SDK's local store runs on node:sqlite, which prints an experimental
 * warning on load. Two lines of noise ahead of one line of output on a routine
 * housekeeping command, about a dependency choice the user can't act on — so
 * this one message is dropped, and every other warning still gets through.
 */
function silenceSqliteWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

async function loadSdk(): Promise<SdkAgentApi> {
  silenceSqliteWarning();
  const require = createRequire(resolve(DEPS_DIR, "package.json"));
  let entry: string;
  try {
    entry = require.resolve("@cursor/sdk");
  } catch {
    throw new Error(
      "@cursor/sdk is not installed. Run bootstrap.sh in the authoring-workflows skill first."
    );
  }
  const sdk = (await import(pathToFileURL(entry).href)) as { Agent: SdkAgentApi };
  return sdk.Agent;
}

// --- reading ----------------------------------------------------------------

interface RawStep {
  type: string;
  message?: Record<string, unknown>;
}

interface RawTurn {
  type: string;
  turn?: { steps?: RawStep[] };
}

/**
 * A transcript flattened into what a viewer renders. The SDK's own turn type is
 * a wide discriminated union that grows with the platform; normalizing here
 * keeps that shape in one file instead of spread through the page script.
 */
export type TranscriptStep =
  | { kind: "thinking"; text: string; durationMs?: number }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; tool: string; args?: unknown; result?: unknown; ok?: boolean }
  | { kind: "other"; label: string; raw: unknown };

export interface Transcript {
  runId: string;
  agentId: string;
  status: string;
  model?: string;
  durationMs?: number;
  tokens?: number;
  /** The prompt this subagent was given, which no progress view records. */
  prompt?: string;
  steps: TranscriptStep[];
  /** Assembled from a running agent, so it is still growing and truncated. */
  live?: boolean;
  /** Steps aged out of the live buffer's cap. */
  droppedSteps?: number;
}

function text(message: Record<string, unknown> | undefined): string {
  const value = message?.["text"];
  return typeof value === "string" ? value : "";
}

function normalizeStep(step: RawStep): TranscriptStep {
  switch (step.type) {
    case "thinkingMessage": {
      const duration = step.message?.["thinkingDurationMs"];
      return {
        kind: "thinking",
        text: text(step.message),
        ...(typeof duration === "number" ? { durationMs: duration } : {}),
      };
    }
    case "assistantMessage":
      return { kind: "assistant", text: text(step.message) };
    case "toolCall": {
      const message = step.message ?? {};
      const result = message["result"] as { status?: string } | undefined;
      return {
        kind: "tool",
        tool: typeof message["type"] === "string" ? message["type"] : "tool",
        args: message["args"],
        result: message["result"],
        ...(result?.status !== undefined ? { ok: result.status === "success" } : {}),
      };
    }
    default:
      return { kind: "other", label: step.type, raw: step };
  }
}

interface UserTurn {
  userMessage?: { text?: string };
}

/**
 * Messages come back as protobuf messages, where the turn is a oneof: at
 * runtime it is `{ turn: { case, value } }`, while its JSON form flattens to
 * `{ agentConversationTurn: ... }`. Both are read so this keeps working
 * whichever representation a given SDK version hands back.
 */
function userTurnOf(message: unknown): UserTurn | undefined {
  const shape = message as {
    agentConversationTurn?: UserTurn;
    turn?: { case?: string; value?: UserTurn };
  };
  return shape?.agentConversationTurn ?? shape?.turn?.value;
}

/**
 * The prompt lives on the agent's message list rather than its conversation
 * turns, so it takes a second read. Worth it: the brief a subagent was given is
 * exactly what a progress view cannot otherwise show.
 */
function extractPrompt(messages: Array<{ type: string; message?: unknown }>): string | undefined {
  for (const entry of messages) {
    if (entry.type !== "user") continue;
    const value = userTurnOf(entry.message)?.userMessage?.text;
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function formatModel(model: SdkRunHandle["model"]): string | undefined {
  if (model === undefined) return undefined;
  if (model.params === undefined || model.params.length === 0) return model.id;
  return `${model.id} (${model.params.map((p) => `${p.id}=${p.value}`).join(", ")})`;
}

/** Loads one subagent's full transcript. Local read; no network, no spend. */
export async function loadTranscript(runId: string, cwd: string): Promise<Transcript> {
  const Agent = await loadSdk();
  const run = await Agent.getRun(runId, { runtime: "local", cwd });

  if (!run.supports("conversation")) {
    throw new Error(`run ${runId} does not expose a conversation`);
  }

  const turns = await run.conversation();
  const steps = turns.flatMap((turn) => (turn.turn?.steps ?? []).map(normalizeStep));

  // A missing message list must not sink the transcript: the steps are the
  // substance, the prompt is context.
  let prompt: string | undefined;
  try {
    prompt = extractPrompt(await Agent.messages.list(run.agentId, { runtime: "local", cwd }));
  } catch {
    prompt = undefined;
  }

  return {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    ...(formatModel(run.model) !== undefined ? { model: formatModel(run.model)! } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.usage?.["totalTokens"] !== undefined ? { tokens: run.usage["totalTokens"] } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    steps,
  };
}

// --- live transcripts -------------------------------------------------------

/**
 * Steps kept per in-flight agent. Generous for watching progress, bounded so a
 * wide fan-out of chatty agents can't grow without limit.
 */
const LIVE_STEP_CAP = 400;

/**
 * Tool payloads are truncated harder here than on the finished page. This buffer
 * lives in the runner's memory for every agent currently running, and a single
 * repo-wide grep result can be megabytes; the untruncated copy is in the SDK's
 * store and becomes readable the moment the agent finishes.
 */
const LIVE_PAYLOAD_LIMIT = 20_000;

interface LiveEntry {
  prompt: string;
  model: string;
  startedAt: number;
  steps: TranscriptStep[];
  /** Steps dropped once the cap was hit, so the page can say so. */
  dropped: number;
}

/**
 * In-memory because the view server runs inside the runner process, so there is
 * nothing to serialize: a live transcript is only ever read by the dashboard of
 * the run producing it. Entries are removed when the agent settles, which is
 * what bounds this to the agents actually in flight.
 */
const liveAgents = new Map<number, LiveEntry>();

function truncateDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LIVE_PAYLOAD_LIMIT
      ? `${value.slice(0, LIVE_PAYLOAD_LIMIT)}\n\n... truncated while running; the finished transcript has all of it`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= LIVE_PAYLOAD_LIMIT) return value;
  return `[${serialized === undefined ? "unserializable" : `${serialized.length} chars`}] omitted while running; the finished transcript has all of it`;
}

export function startLiveTranscript(
  agentNumber: number,
  prompt: string,
  model: string
): void {
  liveAgents.set(agentNumber, {
    prompt,
    model,
    startedAt: Date.now(),
    steps: [],
    dropped: 0,
  });
}

/** Records one step from the SDK's `onStep` callback. Never throws. */
export function pushLiveStep(agentNumber: number, step: unknown): void {
  const entry = liveAgents.get(agentNumber);
  if (entry === undefined) return;
  try {
    const normalized = normalizeStep(step as RawStep);
    if (normalized.kind === "tool") {
      normalized.args = truncateDeep(normalized.args);
      normalized.result = truncateDeep(normalized.result);
    }
    entry.steps.push(normalized);
    if (entry.steps.length > LIVE_STEP_CAP) {
      entry.steps.shift();
      entry.dropped += 1;
    }
  } catch {
    // A step shape this runtime doesn't understand must not sink the agent.
  }
}

/** Called when the agent settles; the SDK's stored copy takes over from here. */
export function endLiveTranscript(agentNumber: number): void {
  liveAgents.delete(agentNumber);
}

/**
 * The transcript of an agent that is still running, assembled from `onStep`.
 *
 * Read from this rather than the SDK for a live agent on purpose: the store's
 * `conversation()` tails the run's event stream and does not resolve until the
 * run reaches a terminal state, so asking it about a running agent would hang
 * until that agent finished.
 */
export function readLiveTranscript(agentNumber: number): Transcript | undefined {
  const entry = liveAgents.get(agentNumber);
  if (entry === undefined) return undefined;
  return {
    runId: "",
    agentId: "",
    status: "running",
    model: entry.model,
    durationMs: Date.now() - entry.startedAt,
    prompt: entry.prompt,
    steps: entry.steps,
    live: true,
    ...(entry.dropped > 0 ? { droppedSteps: entry.dropped } : {}),
  };
}

// --- retention --------------------------------------------------------------

/**
 * `off` disables automatic pruning entirely; anything else is a day count.
 *
 * Only the literal `off` disables it, because `0` reads both ways — "keep for
 * zero days", which would delete everything on the next run, and "zero
 * retention policy", which would keep everything forever. A value that could
 * mean either is not one to guess at on the startup path, so anything that
 * isn't a positive number falls back to the default.
 */
export function configuredTtlDays(env: NodeJS.ProcessEnv = process.env): number | "off" {
  const raw = env["WORKFLOW_TRANSCRIPT_TTL_DAYS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TTL_DAYS;
  if (raw.toLowerCase() === "off") return "off";
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
}

interface Candidate {
  /** Position in the run, which is how the record is found again on re-read. */
  agentNumber: number;
  runId: string;
  cwd: string;
}

export interface PruneSummary {
  dryRun: boolean;
  /** Transcripts the SDK deleted for us. */
  deleted: number;
  /** Candidates the store had already dropped; the record is cleared anyway. */
  missing: number;
  /** Workflow runs whose state was rewritten. */
  runsTouched: number;
  bytesReclaimed: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** When this agent's transcript became eligible to expire. */
function agentAgeAnchor(agent: AgentRecord, state: RunState): number {
  return agent.endedAt ?? state.endedAt ?? state.startedAt;
}

function collectCandidates(cutoff: number | "all"): Map<string, Candidate[]> {
  const byRun = new Map<string, Candidate[]>();
  if (!existsSync(RUNS_DIR)) return byRun;

  for (const id of readdirSync(RUNS_DIR)) {
    const state = readRunState(id);
    if (state === undefined) continue;
    // A live run's agents are still being written to. Never touch them.
    if (state.status === "running" && isAlive(state.pid)) continue;

    const matches = state.agents.filter((agent) => {
      if (agent.runId === undefined) return false;
      return cutoff === "all" || agentAgeAnchor(agent, state) < cutoff;
    });
    if (matches.length === 0) continue;

    byRun.set(
      id,
      matches.map((agent) => ({
        agentNumber: agent.id,
        runId: agent.runId!,
        cwd: agent.cwd ?? state.cwd,
      }))
    );
  }
  return byRun;
}

/** Recursive size of a directory tree, tolerant of races with a live store. */
function directorySize(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(full);
      else total += statSync(full).size;
    } catch {
      // Deleted underneath us; it contributes nothing either way.
    }
  }
  return total;
}

/**
 * Deletes expired subagent transcripts and clears the run records that pointed
 * at them, so the progress views can say the transcript expired rather than
 * offering a link that leads nowhere.
 */
export async function pruneTranscripts(options: {
  days: number | "all";
  dryRun?: boolean;
}): Promise<PruneSummary> {
  const cutoff = options.days === "all" ? "all" : Date.now() - options.days * DAY_MS;
  const dryRun = options.dryRun === true;
  const byRun = collectCandidates(cutoff);

  const summary: PruneSummary = {
    dryRun,
    deleted: 0,
    missing: 0,
    runsTouched: 0,
    bytesReclaimed: 0,
  };
  if (byRun.size === 0) return summary;

  const workspaces = new Set<string>();
  for (const candidates of byRun.values()) {
    for (const candidate of candidates) workspaces.add(candidate.cwd);
  }
  const sizeBefore = [...workspaces].reduce(
    (total, cwd) => total + directorySize(agentStoreDirFor(cwd)),
    0
  );

  if (dryRun) {
    for (const candidates of byRun.values()) summary.deleted += candidates.length;
    summary.runsTouched = byRun.size;
    return summary;
  }

  const Agent = await loadSdk();

  for (const [workflowRunId, candidates] of byRun) {
    for (const candidate of candidates) {
      try {
        const run = await Agent.getRun(candidate.runId, {
          runtime: "local",
          cwd: candidate.cwd,
        });
        await Agent.delete(run.agentId, { cwd: candidate.cwd });
        summary.deleted += 1;
      } catch {
        // Already gone, or the store moved. Either way the record is stale and
        // clearing it is the right outcome.
        summary.missing += 1;
      }
    }

    // Re-read rather than reusing the snapshot the candidates came from: the
    // run may have flushed state since, and the copy on disk is the one that
    // has to end up correct.
    const state = readRunState(workflowRunId);
    if (state === undefined) continue;
    const pruned = new Set(candidates.map((c) => c.agentNumber));
    for (const agent of state.agents) {
      if (!pruned.has(agent.id)) continue;
      delete agent.runId;
      delete agent.cwd;
      agent.transcriptPruned = true;
    }
    writeRunState(state);
    summary.runsTouched += 1;
  }

  const sizeAfter = [...workspaces].reduce(
    (total, cwd) => total + directorySize(agentStoreDirFor(cwd)),
    0
  );
  summary.bytesReclaimed = Math.max(0, sizeBefore - sizeAfter);
  return summary;
}

/**
 * Best-effort retention on the startup path: at most one pass a day, never
 * blocking the run, and silent on failure. A run must not fail because
 * housekeeping did.
 */
export function schedulePrune(env: NodeJS.ProcessEnv = process.env): void {
  const ttl = configuredTtlDays(env);
  if (ttl === "off") return;

  let lastPrune = 0;
  try {
    lastPrune = statSync(LAST_PRUNE_FILE).mtimeMs;
  } catch {
    lastPrune = 0;
  }
  if (Date.now() - lastPrune < AUTO_PRUNE_INTERVAL_MS) return;

  // Claim the slot before the work starts, so two runs launched together don't
  // both prune.
  try {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(LAST_PRUNE_FILE, String(Date.now()));
  } catch {
    return;
  }

  void pruneTranscripts({ days: ttl }).catch(() => {});
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
