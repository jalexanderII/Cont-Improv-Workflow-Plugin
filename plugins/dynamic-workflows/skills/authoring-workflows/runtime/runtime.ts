/**
 * The workflow-facing API: `agent()`, `agentJSON()`, `pipeline()`, `phase()`.
 *
 * A workflow script default-exports an async function; the runner injects
 * these helpers as its argument. The script orchestrates however it likes and
 * returns a final value. Intermediate results stay in script variables, which
 * is the point: only what the script returns reaches a conversation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatModelSelection,
  resolveModelSelection,
} from "./model.js";
import { runCacheDir } from "./paths.js";
import type { RunStore } from "./state.js";
import type {
  AgentRecord,
  ModelSelection,
  WorkflowAgentOptions,
} from "./types.js";

/** Matches the concurrency ceiling Claude Code's workflow runtime applies. */
export const DEFAULT_CONCURRENCY = 16;
/** Runaway-loop backstop. A single run may not exceed this many agents. */
export const DEFAULT_AGENT_CAP = 1000;

/**
 * Kept short deliberately. Previews are held for every agent and serialized
 * into the state snapshot on every change, so a large value costs real
 * throughput on a several-hundred-agent run.
 */
const PREVIEW_CHARS = 200;
const LABEL_CHARS = 80;
const READ_ONLY_DENIALS = ["edit", "shell"];

/**
 * Normalizes any label for display. Cuts on a word boundary so the progress
 * views never show things like "so the agent nam". Applied to labels the
 * script supplies too, so scripts can pass full text and let the views decide
 * how much fits.
 */
function displayLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= LABEL_CHARS) return flat;
  const clipped = flat.slice(0, LABEL_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > LABEL_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped) + "\u2026";
}

interface RuntimeContext {
  store: RunStore;
  workflow: string;
  /** Scopes the result cache, so a fresh run never replays another run's work. */
  runId: string;
  cwd: string;
  /** Run-level default; each agent may override the id, the params, or both. */
  model: ModelSelection;
  /**
   * Undefined means "let the SDK resolve it", which is how a stored
   * `Cursor.auth.login()` gets used. Passing any explicit value, including an
   * empty string, short-circuits that resolution.
   */
  apiKey: string | undefined;
  concurrency: number;
  agentCap: number;
  useCache: boolean;
  dryRun: boolean;
  args: unknown;
  /** Injected by run.ts so this module stays free of a hard SDK import. */
  prompt: SdkPrompt;
}

export type SdkPrompt = (
  message: string,
  options: {
    apiKey?: string;
    model: { id: string; params?: Array<{ id: string; value: string }> };
    local: { cwd: string };
    tools?: string[];
    disallowedTools?: string[];
  }
) => Promise<{
  /** SDK run id. The only handle back to the agent's persisted transcript. */
  id?: string;
  status: string;
  result?: string;
  error?: { message: string };
  usage?: { totalTokens: number };
}>;

let ctx: RuntimeContext | undefined;
let pool: Semaphore | undefined;

export function initRuntime(context: RuntimeContext): void {
  ctx = context;
  pool = new Semaphore(context.concurrency);
}

function requireContext(): RuntimeContext {
  if (ctx === undefined || pool === undefined) {
    throw new Error(
      "Workflow runtime is not initialized. Run workflows through run.ts."
    );
  }
  return ctx;
}

// --- concurrency ------------------------------------------------------------

/**
 * Bounds how many agents are in flight. `pipeline()` creates every task up
 * front so the queue is visible in the progress views immediately; this is
 * what keeps only `limit` of them actually running.
 */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`concurrency must be a positive integer, got ${limit}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

// --- resume cache -----------------------------------------------------------

interface CacheEntry {
  result: string;
  tokens: number;
  model: string;
  savedAt: number;
  /**
   * Carried through the cache so a resumed run's replayed agents still link to
   * the transcript of the call that actually produced the answer.
   */
  runId?: string;
  cwd?: string;
}

/**
 * Content-addresses the call rather than its position in the run. Claude Code
 * replays in start order and re-runs everything after the first agent that
 * didn't finish; addressing by content means only genuinely unfinished work
 * runs again, in any order.
 *
 * Everything that changes what an agent would produce belongs in the hash.
 * The workflow name doesn't, because the cache directory is already per-run.
 *
 * Model parameters are part of it: two agents differing only in `effort` or
 * `fast` are different calls, and sharing a cache entry would make a resume
 * hand back the cheap answer for the expensive one. The selection arrives
 * normalized, so parameter order can't split the key either.
 */
function hashCall(
  prompt: string,
  model: ModelSelection,
  cwd: string,
  tools: string[] | undefined,
  disallowed: string[] | undefined
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        prompt,
        model.id,
        model.params ?? [],
        cwd,
        tools ?? [],
        disallowed ?? [],
      ])
    )
    .digest("hex")
    .slice(0, 16);
}

function readCache(runId: string, hash: string): CacheEntry | undefined {
  try {
    return JSON.parse(
      readFileSync(join(runCacheDir(runId), hash + ".json"), "utf8")
    ) as CacheEntry;
  } catch {
    return undefined;
  }
}

function writeCache(runId: string, hash: string, entry: CacheEntry): void {
  const dir = runCacheDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash + ".json"), JSON.stringify(entry));
}

// --- phases -----------------------------------------------------------------

/**
 * Async-local rather than a module variable: a script is free to run two
 * phases concurrently (`Promise.all([phase("a", ...), phase("b", ...)])`), and
 * a single mutable current-phase would let them clobber each other, filing
 * agents under whichever phase happened to start last.
 */
const phaseContext = new AsyncLocalStorage<string>();

/**
 * Groups everything spawned inside `fn` under a named phase in the progress
 * views. Phases are cosmetic; they don't change scheduling.
 */
export async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const c = requireContext();
  const record = c.store.startPhase(name);
  try {
    return await phaseContext.run(name, fn);
  } finally {
    c.store.endPhase(record);
  }
}

// --- agents -----------------------------------------------------------------

function resolveTools(options: WorkflowAgentOptions): {
  tools?: string[];
  disallowedTools?: string[];
} {
  if (options.tools !== undefined) {
    return { tools: options.tools, disallowedTools: options.disallowedTools };
  }
  const denials = new Set(options.disallowedTools ?? []);
  if (options.readOnly === true) {
    for (const tool of READ_ONLY_DENIALS) denials.add(tool);
  }
  return denials.size > 0 ? { disallowedTools: [...denials] } : {};
}

/**
 * Spawns one subagent and resolves to its final text.
 *
 * Resolves to `null` when the agent fails unrecoverably, matching the
 * convention that lets `pipeline(...).filter(Boolean)` drop dead entries.
 */
export async function agent(
  prompt: string,
  options: WorkflowAgentOptions = {}
): Promise<string | null> {
  const c = requireContext();

  if (c.store.snapshot.agents.length >= c.agentCap) {
    throw new Error(
      `Workflow exceeded its agent cap of ${c.agentCap}. This usually means a loop isn't terminating.`
    );
  }

  const selection = resolveModelSelection(options, c.model);
  const cwd = options.cwd ?? c.cwd;
  const { tools, disallowedTools } = resolveTools(options);
  const hash = hashCall(prompt, selection, cwd, tools, disallowedTools);

  const record = c.store.addAgent({
    label: displayLabel(options.label ?? prompt),
    phase: options.phase ?? phaseContext.getStore() ?? "main",
    hash,
    model: formatModelSelection(selection),
    readOnly: options.readOnly === true,
  });

  const cacheable = options.cache !== false && c.useCache;
  if (cacheable) {
    const hit = readCache(c.runId, hash);
    if (hit !== undefined) {
      c.store.updateAgent(record, "cached", {
        tokens: hit.tokens,
        preview: hit.result.slice(0, PREVIEW_CHARS),
        ...(hit.runId !== undefined ? { runId: hit.runId } : {}),
        ...(hit.cwd !== undefined ? { cwd: hit.cwd } : {}),
      });
      return hit.result;
    }
  }

  await pool!.acquire();
  c.store.updateAgent(record, "running");
  try {
    const result = await c.prompt(prompt, {
      ...(c.apiKey !== undefined ? { apiKey: c.apiKey } : {}),
      // Normalized, so `params` is absent rather than empty when the run and
      // the agent both left it alone: that's what selects the model's default
      // variant instead of an explicit empty parameter set.
      model: selection,
      local: { cwd },
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    });

    const tokens = result.usage?.totalTokens ?? 0;
    // The transcript link is worth keeping on every outcome, and the cwd only
    // when it isn't the run's, since that is what scopes the local agent store.
    const transcript = {
      ...(result.id !== undefined ? { runId: result.id } : {}),
      ...(cwd !== c.cwd ? { cwd } : {}),
    };

    if (result.status !== "finished" || result.result === undefined) {
      c.store.updateAgent(record, "error", {
        tokens,
        ...transcript,
        error: result.error?.message ?? `agent ended with status "${result.status}"`,
      });
      return null;
    }

    c.store.updateAgent(record, "finished", {
      tokens,
      preview: result.result.slice(0, PREVIEW_CHARS),
      ...transcript,
    });
    if (cacheable) {
      writeCache(c.runId, hash, {
        result: result.result,
        tokens,
        model: formatModelSelection(selection),
        savedAt: Date.now(),
        ...transcript,
      });
    }
    return result.result;
  } catch (err) {
    // A throw means the run never started (auth, config, network). The script
    // keeps going so one bad worker doesn't sink a 200-agent fan-out.
    c.store.updateAgent(record, "error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    pool!.release();
  }
}

/**
 * Spawns one subagent and parses its reply as JSON matching `schema`.
 * Resolves to `null` when the agent fails or returns unparseable output.
 */
export async function agentJSON<T>(
  prompt: string,
  schema: object,
  options: WorkflowAgentOptions = {}
): Promise<T | null> {
  const instructed =
    prompt +
    "\n\nRespond with ONLY a JSON value matching this JSON Schema. No prose, no code fence.\n" +
    JSON.stringify(schema);

  const raw = await agent(instructed, options);
  if (raw === null) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Last resort: grab the outermost JSON-looking span.
    const span = candidate.match(/[[{][\s\S]*[\]}]/);
    if (span === null) return null;
    try {
      return JSON.parse(span[0]) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Runs `fn` once per item, bounded by the run's concurrency. Results come back
 * in input order. Failed agents appear as `null`, so callers that need only
 * successes should `.filter(Boolean)`.
 */
export async function pipeline<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item, index) => fn(item, index)));
}

/** The agent records for this run, for scripts that want to report on the run. */
export function runAgents(): readonly AgentRecord[] {
  return requireContext().store.snapshot.agents;
}

/**
 * Bundles the helpers into the object handed to a workflow's default export.
 * Injection rather than import keeps generated scripts free of any path back
 * into the plugin directory.
 */
export function makeWorkflowContext(): {
  agent: typeof agent;
  agentJSON: typeof agentJSON;
  pipeline: typeof pipeline;
  phase: typeof phase;
  args: unknown;
  dryRun: boolean;
  runAgents: typeof runAgents;
} {
  const c = requireContext();
  return {
    agent,
    agentJSON,
    pipeline,
    phase,
    args: c.args,
    dryRun: c.dryRun,
    runAgents,
  };
}
