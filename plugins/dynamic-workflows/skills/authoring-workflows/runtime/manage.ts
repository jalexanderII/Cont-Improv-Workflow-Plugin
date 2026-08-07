/**
 * Run management, backing the `/workflows` command.
 *
 *   wf list [--json] [--limit <n>]
 *   wf show <runId> [--json]
 *   wf watch <runId>
 *   wf stop <runId>
 *   wf resume <runId> [extra run.ts flags]
 *   wf transcript <runId> [<agent#>] [--json]
 *   wf prune [--days <n>] [--all] [--dry-run]
 *   wf clean [--days <n>]
 *
 * Runs are just processes writing to a state directory, so none of this needs
 * to hook into the editor.
 *
 * `prune` removes subagent transcripts, which are megabytes each and live in
 * the SDK's store; `clean` removes this runtime's own run directories, which
 * are kilobytes. Different lifetimes, so they are separate commands — but
 * `clean` prunes first, so deleting a run never orphans its transcripts.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPS_DIR, RUNS_DIR, runDir } from "./paths.js";
import { readRunState } from "./state.js";
import {
  configuredTtlDays,
  DEFAULT_TTL_DAYS,
  formatBytes,
  loadTranscript,
  pruneTranscripts,
  type PruneSummary,
} from "./transcript.js";
import type { RunState } from "./types.js";
import { renderTranscriptPage } from "./view-transcript.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = join(DEPS_DIR, "node_modules", ".bin", "tsx");

function listRuns(): RunState[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .map((id) => readRunState(id))
    .filter((s): s is RunState => s !== undefined)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A run whose process died without finishing is stale, not running. */
function effectiveStatus(state: RunState): string {
  if (state.status === "running" && !isAlive(state.pid)) return "abandoned";
  return state.status;
}

function duration(state: RunState): string {
  const s = Math.round(((state.endedAt ?? Date.now()) - state.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function printTable(runs: RunState[]): void {
  if (runs.length === 0) {
    process.stdout.write("No workflow runs recorded yet.\n");
    return;
  }
  const rows = runs.map((s) => [
    s.runId,
    s.workflow.slice(0, 28),
    effectiveStatus(s),
    `${s.totals.finished + s.totals.cached}/${s.totals.agents}`,
    tokens(s.totals.tokens),
    duration(s),
  ]);
  const headers = ["RUN", "WORKFLOW", "STATUS", "AGENTS", "TOKENS", "TIME"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd() + "\n";

  process.stdout.write(line(headers));
  for (const row of rows) process.stdout.write(line(row));
}

function showRun(runId: string, json: boolean): void {
  const state = readRunState(runId);
  if (state === undefined) {
    process.stderr.write(`unknown run: ${runId}\n`);
    process.exit(66);
  }
  if (json) {
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return;
  }

  process.stdout.write(`${state.workflow}  ${state.runId}\n`);
  process.stdout.write(`status     ${effectiveStatus(state)}  (${duration(state)})\n`);
  process.stdout.write(`workspace  ${state.cwd}\n`);
  process.stdout.write(`script     ${state.file}\n`);
  process.stdout.write(
    `agents     ${state.totals.agents} total, ${state.totals.finished} done, ` +
      `${state.totals.cached} cached, ${state.totals.errored} failed\n`
  );
  process.stdout.write(`tokens     ${tokens(state.totals.tokens)}\n`);
  if (state.viewUrl !== undefined) process.stdout.write(`live view  ${state.viewUrl}\n`);
  if (state.canvasPath !== undefined) process.stdout.write(`canvas     ${state.canvasPath}\n`);
  process.stdout.write(`state      ${runDir(state.runId)}\n`);

  const failures = state.agents.filter(
    (a) => a.status === "error" || a.status === "cancelled"
  );
  if (failures.length > 0) {
    process.stdout.write(`\nfailed agents:\n`);
    for (const f of failures) {
      process.stdout.write(`  #${f.id} ${f.label}\n      ${f.error ?? "unknown"}\n`);
    }
  }
}

async function watchRun(runId: string): Promise<void> {
  let lastSerialized = "";
  for (;;) {
    const state = readRunState(runId);
    if (state === undefined) {
      process.stderr.write(`unknown run: ${runId}\n`);
      process.exit(66);
    }
    const serialized = JSON.stringify(state.totals) + state.status;
    if (serialized !== lastSerialized) {
      lastSerialized = serialized;
      const t = state.totals;
      process.stdout.write(
        `[${duration(state)}] ${effectiveStatus(state)}  ` +
          `${t.finished + t.cached}/${t.agents} agents  ` +
          `${t.running} running  ${t.errored} failed  ${tokens(t.tokens)} tokens\n`
      );
    }
    if (effectiveStatus(state) !== "running") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function stopRun(runId: string): void {
  const state = readRunState(runId);
  if (state === undefined) {
    process.stderr.write(`unknown run: ${runId}\n`);
    process.exit(66);
  }
  if (!isAlive(state.pid)) {
    process.stdout.write(`run ${runId} is not active\n`);
    return;
  }
  // SIGTERM so the runner records the stop and flushes its state first.
  process.kill(state.pid, "SIGTERM");
  process.stdout.write(`sent SIGTERM to ${runId} (pid ${state.pid})\n`);
}

function resumeRun(runId: string, extra: string[]): void {
  const state = readRunState(runId);
  if (state === undefined) {
    process.stderr.write(`unknown run: ${runId}\n`);
    process.exit(66);
  }
  // Relaunch under the *same* run id. The result cache lives in the run's own
  // directory, so continuing in place is what lets completed agents come back
  // from cache while everything unfinished runs again. A new id would start
  // with an empty cache and redo the whole thing.
  const argv = state.argv.filter((a) => a !== "--fresh");
  const withoutRunId = argv.filter(
    (a, i) => a !== "--run-id" && argv[i - 1] !== "--run-id"
  );
  // The bootstrapped tsx, not npx: a resume must not depend on the project's
  // toolchain or on npx resolving a package that was never installed there.
  const child = spawn(
    TSX,
    [join(HERE, "run.ts"), ...withoutRunId, "--run-id", runId, ...extra],
    { cwd: state.cwd, stdio: "inherit" }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

function reportPrune(summary: PruneSummary, scope: string): void {
  if (summary.dryRun) {
    process.stdout.write(
      `would remove ${summary.deleted} transcripts across ${summary.runsTouched} runs (${scope})\n`
    );
    return;
  }
  const missing = summary.missing > 0 ? `, ${summary.missing} already gone` : "";
  process.stdout.write(
    `removed ${summary.deleted} transcripts${missing} across ${summary.runsTouched} runs ` +
      `(${scope}), reclaiming ${formatBytes(summary.bytesReclaimed)}\n`
  );
}

/**
 * Writes one subagent's transcript out as a standalone page.
 *
 * The dashboard can only serve transcripts while the run's own process is
 * alive, but they are retained for days after that. This is how you read one
 * from a run that finished yesterday.
 */
async function transcript(
  runId: string,
  agentNumber: number | undefined,
  json: boolean
): Promise<void> {
  const state = readRunState(runId);
  if (state === undefined) {
    process.stderr.write(`unknown run: ${runId}\n`);
    process.exit(66);
  }

  if (agentNumber === undefined) {
    const rows = state.agents.filter(
      (a) => a.runId !== undefined || a.transcriptPruned === true
    );
    if (rows.length === 0) {
      process.stdout.write(`${runId} has no stored transcripts.\n`);
      return;
    }
    process.stdout.write(`${state.workflow}  ${runId}\n\n`);
    for (const a of rows) {
      const mark = a.runId !== undefined ? "" : "  (expired)";
      process.stdout.write(`  #${a.id}  ${a.phase}  ${a.label}${mark}\n`);
    }
    process.stdout.write(`\nRead one with: wf transcript ${runId} <#>\n`);
    return;
  }

  const record = state.agents.find((a) => a.id === agentNumber);
  if (record === undefined) {
    process.stderr.write(`no agent #${agentNumber} in ${runId}\n`);
    process.exit(66);
  }
  if (record.runId === undefined) {
    process.stderr.write(
      record.transcriptPruned === true
        ? `agent #${agentNumber} transcript expired and was removed by retention\n`
        : `agent #${agentNumber} has no transcript\n`
    );
    process.exit(66);
  }

  const loaded = await loadTranscript(record.runId, record.cwd ?? state.cwd);
  if (json) {
    process.stdout.write(JSON.stringify(loaded, null, 2) + "\n");
    return;
  }

  const dir = join(runDir(runId), "transcripts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `agent-${agentNumber}.html`);
  writeFileSync(
    file,
    renderTranscriptPage({
      ...loaded,
      label: record.label,
      phase: record.phase,
      workflow: state.workflow,
      agentNumber,
    })
  );
  process.stdout.write(`${file}\n`);
}

async function prune(days: number | "all", dryRun: boolean): Promise<void> {
  const summary = await pruneTranscripts({ days, dryRun });
  reportPrune(summary, days === "all" ? "all ages" : `older than ${days}d`);
}

async function clean(days: number): Promise<void> {
  if (!existsSync(RUNS_DIR)) return;

  // Transcripts are addressed by ids that only exist in these run states, so
  // they have to go first or deleting the directory strands them in the SDK
  // store with nothing left pointing at them.
  reportPrune(await pruneTranscripts({ days }), `older than ${days}d`);

  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const id of readdirSync(RUNS_DIR)) {
    const dir = join(RUNS_DIR, id);
    const state = readRunState(id);
    if (state !== undefined && effectiveStatus(state) === "running") continue;
    if (statSync(dir).mtimeMs < cutoff) {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  process.stdout.write(`removed ${removed} run directories older than ${days}d\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (command) {
    case "list":
    case undefined: {
      const limitFlag = rest.indexOf("--limit");
      const limit = limitFlag === -1 ? 20 : Number(rest[limitFlag + 1]);
      const runs = listRuns().slice(0, limit);
      if (json) process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
      else printTable(runs);
      return;
    }
    case "show":
      showRun(positional[0], json);
      return;
    case "watch":
      await watchRun(positional[0]);
      return;
    case "stop":
      stopRun(positional[0]);
      return;
    case "resume":
      resumeRun(positional[0], rest.slice(rest.indexOf(positional[0]) + 1));
      return;
    case "transcript": {
      const [runId, agent] = positional;
      if (runId === undefined) {
        process.stderr.write("usage: wf transcript <runId> [<agent#>] [--json]\n");
        process.exit(64);
      }
      const number = agent === undefined ? undefined : Number(agent);
      if (number !== undefined && !Number.isInteger(number)) {
        process.stderr.write(`agent must be a number, got: ${agent}\n`);
        process.exit(64);
      }
      await transcript(runId, number, json);
      return;
    }
    case "prune": {
      const daysFlag = rest.indexOf("--days");
      const configured = configuredTtlDays();
      // `off` only disables the automatic pass; asking for a prune explicitly
      // still needs a cutoff, so fall back to the default.
      const fallback = configured === "off" ? DEFAULT_TTL_DAYS : configured;
      const days = rest.includes("--all")
        ? ("all" as const)
        : daysFlag === -1
          ? fallback
          : Number(rest[daysFlag + 1]);
      if (days !== "all" && (!Number.isFinite(days) || days < 0)) {
        process.stderr.write(`--days must be a non-negative number\n`);
        process.exit(64);
      }
      await prune(days, rest.includes("--dry-run"));
      return;
    }
    case "clean": {
      const daysFlag = rest.indexOf("--days");
      await clean(daysFlag === -1 ? 14 : Number(rest[daysFlag + 1]));
      return;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(64);
  }
}

void main();
