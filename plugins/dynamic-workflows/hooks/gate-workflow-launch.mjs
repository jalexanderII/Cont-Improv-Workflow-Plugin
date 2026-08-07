#!/usr/bin/env node
/**
 * Confirms a real workflow launch before it spends anything.
 *
 * Claude Code shows a per-run approval card listing the planned phases. Cursor
 * has no equivalent surface, so the closest honest substitute is to intercept
 * the launch command and make the cost explicit. Dry runs pass straight
 * through: they spawn nothing and cost nothing, so gating them would only train
 * people to click past the prompt.
 *
 * Node only, no dependencies — the runtime already requires it.
 */

const ALLOW = JSON.stringify({ permission: "allow" });

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
  });
}

function flagValue(command, flag, fallback) {
  const match = command.match(new RegExp(`${flag}\\s+(\\S+)`));
  return match === null ? fallback : match[1];
}

const raw = await readStdin();

let command = "";
try {
  command = JSON.parse(raw).command ?? "";
} catch {
  // Unparseable input is not a reason to block a shell command.
  process.stdout.write(ALLOW);
  process.exit(0);
}

const launching = /\bwf\s+(run|tmux)\b/.test(command);
const dryRun = command.includes("--dry-run");

if (!launching || dryRun) {
  process.stdout.write(ALLOW);
  process.exit(0);
}

const concurrency = flagValue(command, "--concurrency", "16");
const cap = flagValue(command, "--cap", "1000");
const script = command.match(/(\S+\.ts)\b/)?.[1] ?? "the workflow script";

process.stdout.write(
  JSON.stringify({
    permission: "ask",
    user_message:
      `This launches a real workflow run of ${script}.\n\n` +
      `It can spawn up to ${cap} agents, ${concurrency} at a time, billed to ` +
      `CURSOR_API_KEY separately from this session. Agents that aren't marked ` +
      `read-only can edit files and run shell commands.\n\n` +
      `Re-run with --dry-run first if you haven't validated the script.`,
    agent_message:
      "The workflow launch is awaiting user approval. Do not retry, and do not " +
      "work around the gate by invoking the runtime directly.",
  })
);
