/**
 * Workflow entry point.
 *
 *   wf run <name-or-path> [options]
 *
 *   --args <json>        Value exposed to the script as its args
 *   --model <id>         Catalog model id for every agent (default composer-2.5)
 *   --param <id=value>   Model parameter, repeatable: --param effort=high
 *   --concurrency <n>    Max simultaneous agents (default 16)
 *   --cap <n>            Hard agent ceiling for the run (default 1000)
 *   --dry-run            Stub every agent: no network, no spend
 *   --fresh              Ignore the resume cache and re-run every agent
 *   --run-id <id>        Continue under a specific run id (used by resume)
 *   --port <n>           Fixed port for the live view (default: ephemeral)
 *   --linger <seconds>   Keep the live view up after the run ends
 *   --no-server          Skip the live HTTP view
 *   --no-canvas          Skip the final canvas
 *   --json               Print the machine-readable summary only
 *
 * `--model` takes a catalog id only. Effort and speed are parameters, so Grok
 * at high effort with fast enabled is:
 *
 *   --model grok-4.5 --param effort=high --param fast=true
 *
 * not `--model cursor-grok-4.5-high-fast`, which is a UI slug the backend
 * rejects. `WORKFLOW_MODEL` and `WORKFLOW_MODEL_PARAMS` (`effort=high,fast=true`)
 * set the same two defaults from the environment.
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { authHelpText, resolveAuth } from "./auth.js";
import {
  normalizeModelSelection,
  parseModelParam,
  parseModelParamList,
  upsertModelParam,
} from "./model.js";
import { DEPS_DIR } from "./paths.js";
import { RunStore } from "./state.js";
import {
  DEFAULT_AGENT_CAP,
  DEFAULT_CONCURRENCY,
  initRuntime,
  makeWorkflowContext,
  type SdkPrompt,
} from "./runtime.js";
import { schedulePrune } from "./transcript.js";
import type { ModelParameterValue, RunState, WorkflowMeta } from "./types.js";
import { attachTui } from "./view-tui.js";
import { emitCanvas } from "./view-canvas.js";
import { startViewServer } from "./view-server.js";

interface Options {
  file: string;
  args: unknown;
  /** Catalog id only; effort and speed live in `modelParams`. */
  model: string;
  modelParams: ModelParameterValue[];
  concurrency: number;
  cap: number;
  fresh: boolean;
  port: number;
  server: boolean;
  canvas: boolean;
  json: boolean;
  dryRun: boolean;
  /** Caller-supplied id, so a launcher can watch the run it just started. */
  runId: string;
  /**
   * Seconds to keep the dashboard up after the run ends, so a page whose last
   * poll landed mid-run can render the finished frame instead of freezing on
   * "running".
   *
   * Zero by default because a foreground run would otherwise refuse to exit
   * for that long, and its terminal already shows the final state. `wf tmux`
   * sets it, since a detached run's only view is the dashboard.
   */
  lingerSeconds: number;
}

/** Workflows shipped with the plugin, e.g. `deep-research`. */
const BUNDLED_WORKFLOWS = fileURLToPath(
  new URL("../../../workflows", import.meta.url)
);

/**
 * Accepts a path or a bare workflow name. Names resolve from the project's
 * workflows, then the user's, then the ones bundled with the plugin — so
 * `wf run deep-research` works from anywhere, and a project can shadow a
 * bundled workflow by using the same name.
 */
function resolveWorkflow(nameOrPath: string): string | undefined {
  const direct = isAbsolute(nameOrPath)
    ? nameOrPath
    : resolve(process.cwd(), nameOrPath);
  if (existsSync(direct)) return direct;
  if (nameOrPath.includes("/")) return undefined;

  const bare = nameOrPath.replace(/\.ts$/, "");
  for (const dir of [
    join(process.cwd(), ".cursor", "workflows"),
    join(homedir(), ".cursor", "workflows"),
    BUNDLED_WORKFLOWS,
  ]) {
    const candidate = join(dir, `${bare}.ts`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Numeric flags are validated at the boundary. An unparsed `NaN` reaching the
 * concurrency pool would make every acquire wait forever, which presents as a
 * run that starts and then hangs with no error at all.
 */
function numberFlag(raw: string | undefined, flag: string, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`${flag} expects a number >= ${min}, got ${raw ?? "nothing"}`);
    process.exit(64);
  }
  return value;
}

/**
 * Validates `--param` for shape only. Which ids and values a given model
 * accepts is the backend's to decide, and checking here would mean a
 * `Cursor.models.list()` round trip on every run just to read a flag. An
 * invalid combination surfaces as an agent error at start, which the fan-out
 * already records and survives.
 */
function paramFlag(
  raw: string | undefined,
  flag: string,
  existing: ModelParameterValue[]
): ModelParameterValue[] {
  try {
    return upsertModelParam(existing, parseModelParam(raw ?? ""));
  } catch (err) {
    console.error(`${flag} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(64);
  }
}

/** `WORKFLOW_MODEL_PARAMS=effort=high,fast=true`, the env form of `--param`. */
function paramsFromEnv(): ModelParameterValue[] {
  const raw = process.env.WORKFLOW_MODEL_PARAMS;
  if (raw === undefined || raw.trim() === "") return [];
  try {
    return parseModelParamList(raw);
  } catch (err) {
    console.error(
      `WORKFLOW_MODEL_PARAMS ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(64);
  }
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const opts: Options = {
    file: "",
    args: undefined,
    model: process.env.WORKFLOW_MODEL ?? "composer-2.5",
    modelParams: paramsFromEnv(),
    concurrency: numberFlag(
      process.env.WORKFLOW_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
      "WORKFLOW_CONCURRENCY",
      1
    ),
    cap: DEFAULT_AGENT_CAP,
    fresh: false,
    port: 0,
    server: true,
    canvas: true,
    json: false,
    dryRun: false,
    runId: "",
    lingerSeconds: numberFlag(
      process.env.WORKFLOW_LINGER_SECONDS ?? "0",
      "WORKFLOW_LINGER_SECONDS",
      0
    ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--args":
        try {
          opts.args = JSON.parse(argv[++i] ?? "null");
        } catch {
          // A bare string is a perfectly good argument; don't demand JSON.
          opts.args = argv[i];
        }
        break;
      case "--model":
        opts.model = argv[++i] ?? opts.model;
        break;
      case "--param":
        opts.modelParams = paramFlag(argv[++i], "--param", opts.modelParams);
        break;
      case "--concurrency":
        opts.concurrency = numberFlag(argv[++i], "--concurrency", 1);
        break;
      case "--cap":
        opts.cap = numberFlag(argv[++i], "--cap", 1);
        break;
      case "--port":
        opts.port = numberFlag(argv[++i], "--port", 0);
        break;
      case "--run-id":
        opts.runId = argv[++i] ?? "";
        break;
      case "--linger":
        opts.lingerSeconds = numberFlag(argv[++i], "--linger", 0);
        break;
      case "--fresh":
        opts.fresh = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-server":
        opts.server = false;
        break;
      case "--no-canvas":
        opts.canvas = false;
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        positional.push(arg);
    }
  }

  opts.file = positional[0] ?? "";
  return opts;
}

/**
 * Builds a synthetic instance of a JSON Schema, used by `--dry-run` so a
 * workflow's control flow can be exercised without spending tokens. Arrays get
 * two entries so fan-out phases actually fan out.
 */
function fakeFromSchema(schema: Record<string, unknown>, depth = 0): unknown {
  const type = schema.type as string | undefined;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required as string[] | undefined) ?? Object.keys(props);
      const out: Record<string, unknown> = {};
      for (const key of required) {
        out[key] = props[key] === undefined ? "dry-run" : fakeFromSchema(props[key], depth + 1);
      }
      return out;
    }
    case "array":
      if (depth > 3 || schema.items === undefined) return [];
      return [0, 1].map((i) => {
        const item = fakeFromSchema(schema.items as Record<string, unknown>, depth + 1);
        return typeof item === "string" ? `${item}-${i}` : item;
      });
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    default:
      return "dry-run";
  }
}

/**
 * Stub executor: no network, no spend, small delay so the views animate.
 * `WORKFLOW_DRYRUN_DELAY_MS` stretches that delay, which is how you keep a run
 * alive long enough to work on the progress views.
 */
function dryRunPrompt(): SdkPrompt {
  const base = Number(process.env.WORKFLOW_DRYRUN_DELAY_MS ?? 150);
  return async (message) => {
    await new Promise((r) => setTimeout(r, base + Math.random() * 400));
    // agentJSON appends the schema as the final line; anything else that looks
    // like `{"type"` is a nested subschema and must not be matched.
    const lastLine = message.slice(message.lastIndexOf("\n") + 1);
    if (lastLine.startsWith("{")) {
      try {
        const schema = JSON.parse(lastLine) as Record<string, unknown>;
        return {
          status: "finished",
          result: JSON.stringify(fakeFromSchema(schema)),
          usage: { totalTokens: 0 },
        };
      } catch {
        // Fall through to the text stub.
      }
    }
    return {
      status: "finished",
      result: "[dry run] no agent was executed for this step.",
      usage: { totalTokens: 0 },
    };
  };
}

/** Loads @cursor/sdk from the runtime's own dependency directory. */
async function loadSdkPrompt(): Promise<SdkPrompt> {
  const require = createRequire(resolve(DEPS_DIR, "package.json"));
  let entry: string;
  try {
    entry = require.resolve("@cursor/sdk");
  } catch {
    throw new Error(
      `@cursor/sdk is not installed. Run bootstrap.sh in the authoring-workflows skill first.`
    );
  }
  const sdk = (await import(pathToFileURL(entry).href)) as {
    Agent: { prompt: SdkPrompt };
  };
  return sdk.Agent.prompt.bind(sdk.Agent);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file === "") {
    console.error("usage: run.ts <workflow-file> [options]");
    process.exit(64);
  }

  const file = resolveWorkflow(opts.file);
  if (file === undefined) {
    console.error(
      `workflow not found: ${opts.file}\n\n` +
        "Give a path, or a bare name resolved from:\n" +
        `  ${join(process.cwd(), ".cursor", "workflows")}\n` +
        `  ${join(homedir(), ".cursor", "workflows")}\n` +
        `  ${BUNDLED_WORKFLOWS}`
    );
    process.exit(66);
  }

  const auth = resolveAuth(process.cwd());
  if (auth.source === "none" && !opts.dryRun) {
    console.error(authHelpText());
    console.error("\nOr pass --dry-run to exercise the workflow without spawning agents.");
    process.exit(78);
  }
  if (!opts.json && !opts.dryRun) {
    process.stdout.write(`auth: ${auth.source} (${auth.detail})\n`);
  }

  // Transcripts are large and accumulate per agent, so retention runs itself
  // rather than waiting to be asked. A dry run stays side-effect free.
  if (!opts.dryRun) schedulePrune();

  const module = (await import(pathToFileURL(file).href)) as {
    meta?: WorkflowMeta;
    default?: (ctx: ReturnType<typeof makeWorkflowContext>) => Promise<unknown>;
  };

  if (typeof module.default !== "function") {
    console.error(
      `${file} must default-export an async function. See the authoring-workflows skill.`
    );
    process.exit(64);
  }

  const workflow = module.meta?.name ?? file.split("/").pop()!.replace(/\.[tj]s$/, "");
  const runId =
    opts.runId !== ""
      ? opts.runId
      : new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) +
        "-" +
        randomUUID().slice(0, 8);

  const state: RunState = {
    runId,
    workflow,
    description: module.meta?.description,
    cwd: process.cwd(),
    file,
    argv: process.argv.slice(2),
    pid: process.pid,
    status: "running",
    startedAt: Date.now(),
    args: opts.args,
    concurrency: opts.concurrency,
    agentCap: opts.cap,
    phases: [],
    agents: [],
    totals: { agents: 0, pending: 0, running: 0, finished: 0, cached: 0, errored: 0, tokens: 0 },
  };

  const store = new RunStore(state);
  initRuntime({
    store,
    workflow,
    runId,
    cwd: process.cwd(),
    model: normalizeModelSelection({ id: opts.model, params: opts.modelParams }),
    concurrency: opts.concurrency,
    agentCap: opts.cap,
    // A dry run must never reuse real results, or it would report cached work
    // as if the stub had produced it.
    useCache: !opts.fresh && !opts.dryRun,
    dryRun: opts.dryRun,
    args: opts.args,
    apiKey: auth.apiKey,
    prompt: opts.dryRun ? dryRunPrompt() : await loadSdkPrompt(),
  });

  const server = opts.server ? await startViewServer(store, opts.port) : undefined;
  if (server !== undefined) store.setViewUrl(server.url);
  const detachTui = opts.json ? () => {} : attachTui(store);

  const stop = () => {
    store.finish("stopped");
    detachTui();
    server?.close();
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let report: unknown;
  let failed = false;
  try {
    report = await module.default(makeWorkflowContext());
    store.finish("finished");
  } catch (err) {
    failed = true;
    report = err instanceof Error ? err.stack ?? err.message : String(err);
    store.finish("error", err instanceof Error ? err.message : String(err));
  }

  if (opts.canvas) {
    try {
      store.setCanvasPath(emitCanvas(store.snapshot, report, process.cwd()));
    } catch (err) {
      console.error(
        "canvas emit failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  detachTui();

  const summary = {
    runId,
    workflow,
    status: store.snapshot.status,
    totals: store.snapshot.totals,
    runDir: store.dir,
    canvasPath: store.snapshot.canvasPath,
    report,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write("\n===== WORKFLOW REPORT =====\n");
    process.stdout.write(
      (typeof report === "string" ? report : JSON.stringify(report, null, 2)) + "\n"
    );
    process.stdout.write("===== END REPORT =====\n\n");
    process.stdout.write(`run:    ${runId}\n`);
    process.stdout.write(`state:  ${store.dir}\n`);
    if (store.snapshot.canvasPath !== undefined) {
      process.stdout.write(`canvas: ${store.snapshot.canvasPath}\n`);
    }
  }

  // The run state is already terminal, so a linger gives any open dashboard
  // time to poll once more and render the finished frame instead of freezing
  // on whatever it last saw mid-run.
  if (server !== undefined && opts.lingerSeconds > 0) {
    if (!opts.json) {
      process.stdout.write(
        `\ndashboard: ${server.url} (live for ${opts.lingerSeconds}s more, then use the canvas)\n`
      );
    }
    await new Promise((r) => setTimeout(r, opts.lingerSeconds * 1000));
  }
  server?.close();

  process.exit(failed ? 2 : 0);
}

void main();
