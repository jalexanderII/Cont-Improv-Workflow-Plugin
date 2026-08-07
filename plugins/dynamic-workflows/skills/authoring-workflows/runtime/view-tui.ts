/**
 * Terminal progress view. This is the closest analogue to Claude Code's
 * `/workflows` pane, and the one that costs nothing: run the workflow in a
 * tmux pane and both you and the agent can read it.
 *
 * Falls back to plain append-only lines when stdout isn't a TTY, so piping to
 * a log file stays readable.
 */

import type { RunStore } from "./state.js";
import type { AgentRecord, RunState } from "./types.js";

const REDRAW_MS = 400;
const MAX_ROWS = 24;

const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const CYAN = "\u001b[36m";

function elapsed(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function statusMark(agent: AgentRecord): string {
  switch (agent.status) {
    case "running":
      return `${YELLOW}*${RESET}`;
    case "finished":
      return `${GREEN}+${RESET}`;
    case "cached":
      return `${CYAN}=${RESET}`;
    case "error":
    case "cancelled":
      return `${RED}!${RESET}`;
    default:
      return `${DIM}.${RESET}`;
  }
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, width - 1) + "\u2026";
}

function render(state: RunState): string {
  const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 140));
  const lines: string[] = [];
  const t = state.totals;

  lines.push(
    `${BOLD}${state.workflow}${RESET} ${DIM}${state.runId}${RESET}  ${elapsed(state.startedAt, state.endedAt)}`
  );
  lines.push(
    `${DIM}agents${RESET} ${t.agents}  ` +
      `${YELLOW}running${RESET} ${t.running}  ` +
      `${GREEN}done${RESET} ${t.finished}  ` +
      `${CYAN}cached${RESET} ${t.cached}  ` +
      `${RED}failed${RESET} ${t.errored}  ` +
      `${DIM}tokens${RESET} ${tokens(t.tokens)}`
  );
  if (state.viewUrl !== undefined) {
    lines.push(`${DIM}live view ${state.viewUrl}${RESET}`);
  }
  lines.push("");

  // Show running work first: that's what someone watching actually wants.
  const ordered = [...state.agents].sort((a, b) => {
    const rank = (x: AgentRecord) =>
      x.status === "running" ? 0 : x.status === "pending" ? 2 : 1;
    return rank(a) - rank(b) || a.id - b.id;
  });

  const labelWidth = width - 26;
  for (const a of ordered.slice(0, MAX_ROWS)) {
    const dur =
      a.startedAt === undefined ? "" : elapsed(a.startedAt, a.endedAt);
    const meta = `${dur.padStart(6)} ${tokens(a.tokens).padStart(6)}`;
    lines.push(
      `${statusMark(a)} ${DIM}${String(a.id).padStart(3)}${RESET} ` +
        `${truncate(a.label, labelWidth).padEnd(labelWidth)} ${DIM}${meta}${RESET}`
    );
  }
  if (ordered.length > MAX_ROWS) {
    lines.push(`${DIM}  ... ${ordered.length - MAX_ROWS} more${RESET}`);
  }

  return lines.join("\n");
}

export function attachTui(store: RunStore): () => void {
  const interactive = process.stdout.isTTY === true;

  if (!interactive) {
    // Plain mode: one line per status transition, no cursor games.
    let seen = 0;
    const unsubscribe = store.onChange((state) => {
      for (const a of state.agents.slice(seen)) {
        process.stdout.write(`[${a.phase}] agent ${a.id} queued: ${a.label}\n`);
        seen += 1;
      }
    });
    return unsubscribe;
  }

  process.stdout.write("\u001b[?25l"); // hide cursor
  let lastHeight = 0;
  const draw = () => {
    const body = render(store.snapshot);
    const height = body.split("\n").length;
    process.stdout.write(
      (lastHeight > 0 ? `\u001b[${lastHeight}A` : "") + "\u001b[0J" + body + "\n"
    );
    lastHeight = height + 1;
  };

  const timer = setInterval(draw, REDRAW_MS);
  return () => {
    clearInterval(timer);
    draw();
    process.stdout.write("\u001b[?25h"); // restore cursor
  };
}
