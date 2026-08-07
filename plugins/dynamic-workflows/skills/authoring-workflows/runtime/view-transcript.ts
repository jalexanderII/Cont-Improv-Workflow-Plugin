/**
 * One subagent's transcript as a standalone page.
 *
 * Its own document rather than a panel on the dashboard, because comparing
 * subagents is the point: three verifiers that disagreed, or a worker against
 * the synthesizer that used it, want to be open beside each other.
 *
 * Rendered entirely on the server with no client script. Tool calls collapse
 * through native `<details>`, so the page needs no JavaScript, and saving it
 * with Cmd+S keeps a working copy after the run's server is gone.
 */

import type { Transcript, TranscriptStep } from "./transcript.js";

/** Args are usually small; results can be a whole file or a repo-wide grep. */
const ARGS_LIMIT = 4_000;
const RESULT_LIMIT = 40_000;
const PROMPT_LIMIT = 40_000;

function esc(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );
}

function clamp(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return (
    value.slice(0, limit) +
    `\n\n... truncated, ${value.length - limit} more characters`
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function block(label: string, cls: string, body: string): string {
  return (
    `<div class="step"><div class="step-label">${esc(label)}</div>` +
    `<div class="bubble ${cls}">${esc(body)}</div></div>`
  );
}

function stepHtml(step: TranscriptStep): string {
  switch (step.kind) {
    case "thinking":
      return block(
        step.durationMs !== undefined
          ? `Thinking · ${seconds(step.durationMs)}`
          : "Thinking",
        "thinking",
        step.text
      );
    case "assistant":
      return block("Assistant", "assistant", step.text);
    case "tool": {
      const failed = step.ok === false;
      const parts = [
        step.args !== undefined
          ? `<pre>${esc(clamp(pretty(step.args), ARGS_LIMIT))}</pre>`
          : "",
        step.result !== undefined
          ? `<pre>${esc(clamp(pretty(step.result), RESULT_LIMIT))}</pre>`
          : "",
      ];
      // Failures open by default: when a subagent went wrong, the tool call
      // that failed is the thing you came to read.
      return (
        `<div class="step"><details class="tool"${failed ? " open" : ""}` +
        ` data-failed="${failed}">` +
        `<summary><b>${esc(step.tool)}</b>${failed ? " — failed" : ""}</summary>` +
        parts.join("") +
        `</details></div>`
      );
    }
    default:
      return block(step.label, "", clamp(pretty(step.raw), ARGS_LIMIT));
  }
}

export interface TranscriptPageData extends Transcript {
  label: string;
  phase: string;
  /** The workflow run this subagent belongs to, for the back link. */
  workflow: string;
  agentNumber: number;
}

const STYLE = `
:root {
  --bg: #0d0d0f;
  --surface: #141417;
  --surface-hi: #1a1a1e;
  --line: #26262c;
  --line-soft: #1e1e23;
  --fg: #e8e8ec;
  --fg-2: #a0a0aa;
  --fg-3: #6e6e78;
  --accent: #6ea8fe;
  --err: #e06c6c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.6 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
header {
  position: sticky;
  top: 0;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  padding: 16px 28px 10px;
}
h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.facts { display: flex; flex-wrap: wrap; gap: 14px; color: var(--fg-3); font-size: 11px; }
.facts a { color: var(--accent); text-decoration: none; }
.facts a:hover { text-decoration: underline; }
main { max-width: 900px; margin: 0 auto; padding: 20px 28px 60px; }
.step { margin-bottom: 16px; }
.step-label {
  font-size: 10px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 5px;
}
/* pre-wrap rather than a markdown renderer: this runtime ships no
   dependencies, and half-parsed markdown reads worse than the raw text. */
.bubble {
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 11px 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bubble.prompt { background: var(--surface-hi); border-color: var(--line); }
.bubble.assistant { border-left: 2px solid var(--accent); }
.bubble.thinking { color: var(--fg-2); font-size: 12px; }
details.tool {
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 8px 13px;
}
details.tool[data-failed="true"] { border-color: var(--err); }
details.tool > summary { cursor: pointer; color: var(--fg-2); font-size: 12px; }
details.tool > summary b { color: var(--fg); font-weight: 600; }
details.tool pre {
  margin: 9px 0 2px;
  padding: 9px;
  background: var(--bg);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 11px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  max-height: 420px;
}
.empty { color: var(--fg-3); padding: 24px 0; }
`;

function document_(title: string, header: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark" />
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>${header}</header>
<main>${body}</main>
</body>
</html>`;
}

/** Shown in the tab the user just opened, rather than a bare JSON error. */
export function renderTranscriptError(agentNumber: number, message: string): string {
  return document_(
    `Transcript unavailable`,
    `<h1>Transcript unavailable</h1>` +
      `<div class="facts"><span>agent #${agentNumber}</span>` +
      `<a href="/">&larr; back to the run</a></div>`,
    `<div class="empty">${esc(message)}</div>`
  );
}

export function renderTranscriptPage(data: TranscriptPageData): string {
  const facts = [
    esc(data.phase),
    esc(data.status),
    ...(data.model !== undefined ? [esc(data.model)] : []),
    ...(data.durationMs !== undefined ? [seconds(data.durationMs)] : []),
    ...(data.tokens !== undefined ? [`${tokenCount(data.tokens)} tokens`] : []),
    `${data.steps.length} steps`,
  ];

  const body =
    (data.prompt !== undefined
      ? block("Prompt", "prompt", clamp(data.prompt, PROMPT_LIMIT))
      : "") +
    (data.steps.length === 0
      ? '<div class="empty">This agent recorded no steps.</div>'
      : data.steps.map(stepHtml).join(""));

  return document_(
    `#${data.agentNumber} ${esc(data.label)} — ${esc(data.workflow)}`,
    `<h1>#${data.agentNumber} ${esc(data.label)}</h1>` +
      `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join("")}` +
      `<a href="/">&larr; ${esc(data.workflow)}</a></div>`,
    body
  );
}
