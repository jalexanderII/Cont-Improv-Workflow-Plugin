/**
 * Save a run's script as a reusable slash command.
 *
 *   wf save <runId> [--name <name>] [--personal] [--force]
 *
 * The equivalent of pressing `s` in Claude Code's /workflows view. Two
 * artifacts come out of it: the script in a workflows directory, and a command
 * file that makes it invocable as `/<name>`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readRunState } from "./state.js";

interface Target {
  /** Where the script lives. */
  workflowsDir: string;
  /** Where the command file lives. */
  commandsDir: string;
  /** How the command file should refer to the runner and script. */
  pathStyle: "project-relative" | "absolute";
  label: string;
}

function resolveTarget(cwd: string, personal: boolean): Target {
  if (personal) {
    const root = join(homedir(), ".cursor");
    return {
      workflowsDir: join(root, "workflows"),
      commandsDir: join(root, "commands"),
      pathStyle: "absolute",
      label: "personal (~/.cursor, every project, only you)",
    };
  }
  return {
    workflowsDir: join(cwd, ".cursor", "workflows"),
    commandsDir: join(cwd, ".cursor", "commands"),
    pathStyle: "project-relative",
    label: "project (.cursor, shared with everyone who clones the repo)",
  };
}

/** Pulls `description` out of the script's exported meta block, if present. */
function readDescription(scriptPath: string): string | undefined {
  try {
    const source = readFileSync(scriptPath, "utf8");
    const match = source.match(/description:\s*["'`]([^"'`]+)["'`]/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The generated command stays deliberately thin.
 *
 * Credentials, launching, visibility, polling, reporting, and the honesty
 * rules live in the running-workflows skill, and every workflow command defers
 * to it. Copying that procedure into each saved command would mean N drifting
 * copies of it the moment the plugin changes.
 */
function commandBody(options: {
  name: string;
  description: string;
  runner: string;
  script: string;
  procedure: string;
  exampleArgs: string;
  argHint: string;
  agentCount: number;
  durationHint: string;
}): string {
  const {
    name,
    description,
    runner,
    script,
    procedure,
    exampleArgs,
    argHint,
    agentCount,
    durationHint,
  } = options;
  return `# ${name}

${description}

The user's input for this run is whatever follows the command.

## Procedure

Follow \`${procedure}\` for preflight, cost confirmation, launching,
visibility, polling, reporting, and the honesty rules. Everything below is
specific to this workflow.

- Runner: \`${runner}\`
- Script: \`${script}\`

## Arguments

${argHint}

The run this command was saved from used:

\`\`\`json
${exampleArgs}
\`\`\`

## Scale

That run spawned ${agentCount} agents and took ${durationHint}. Expect the
same order of magnitude for similar inputs, and say so before launching.
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const runId = argv.find((a) => !a.startsWith("--"));
  if (runId === undefined) {
    console.error("usage: save.ts <runId> [--name <name>] [--personal] [--force]");
    process.exit(64);
  }

  const personal = argv.includes("--personal");
  const force = argv.includes("--force");
  const nameFlag = argv.indexOf("--name");

  const state = readRunState(runId);
  if (state === undefined) {
    console.error(`unknown run: ${runId}`);
    process.exit(66);
  }

  const name =
    nameFlag === -1
      ? state.workflow.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()
      : argv[nameFlag + 1];

  const target = resolveTarget(state.cwd, personal);
  mkdirSync(target.workflowsDir, { recursive: true });
  mkdirSync(target.commandsDir, { recursive: true });

  // Move the script into the workflows directory unless it already lives there.
  const scriptDest = join(target.workflowsDir, `${name}.ts`);
  if (resolve(state.file) !== resolve(scriptDest)) {
    if (existsSync(scriptDest) && !force) {
      console.error(
        `${scriptDest} already exists. Pass --force to overwrite, or --name to save under a different name.`
      );
      process.exit(73);
    }
    copyFileSync(state.file, scriptDest);
  }

  const commandDest = join(target.commandsDir, `${name}.md`);
  if (existsSync(commandDest) && !force) {
    console.error(
      `${commandDest} already exists. Pass --force to overwrite, or --name to save under a different name.`
    );
    process.exit(73);
  }

  // The command file has to reference paths that resolve for whoever runs it:
  // repo-relative for a project save, absolute for a personal one.
  const runnerAbs = fileURLToPath(new URL("../wf", import.meta.url));
  const runner =
    target.pathStyle === "project-relative"
      ? relative(state.cwd, runnerAbs)
      : runnerAbs;
  const script =
    target.pathStyle === "project-relative"
      ? relative(state.cwd, scriptDest)
      : scriptDest;

  const description =
    state.description ??
    readDescription(scriptDest) ??
    `Run the ${name} workflow.`;

  const exampleArgs = JSON.stringify(state.args ?? {}, null, 2);
  const argHint =
    state.args === undefined || state.args === null
      ? "This workflow took no arguments; pass the user's input only if the script accepts any."
      : "Map the user's request onto the same shape, leaving any keys they don't mention at these values.";

  const procedureAbs = fileURLToPath(
    new URL("../../running-workflows/SKILL.md", import.meta.url)
  );
  const procedure =
    target.pathStyle === "project-relative"
      ? relative(state.cwd, procedureAbs)
      : procedureAbs;

  const elapsedMs = (state.endedAt ?? state.startedAt) - state.startedAt;
  const durationHint =
    elapsedMs < 60_000
      ? `${Math.max(1, Math.round(elapsedMs / 1000))}s`
      : `${Math.round(elapsedMs / 60_000)}m`;

  writeFileSync(
    commandDest,
    commandBody({
      name,
      description,
      runner,
      script,
      procedure,
      exampleArgs,
      argHint,
      agentCount: state.totals.agents,
      durationHint,
    })
  );

  process.stdout.write(`Saved as /${name}\n\n`);
  process.stdout.write(`  location : ${target.label}\n`);
  process.stdout.write(`  script   : ${scriptDest}\n`);
  process.stdout.write(`  command  : ${commandDest}\n\n`);
  process.stdout.write(`Invoke it in a new chat with /${name}, or run it directly:\n`);
  process.stdout.write(`  ${runner} tmux ${script} --args '${JSON.stringify(state.args ?? {})}'\n`);
  if (!personal) {
    process.stdout.write(
      `\nBoth files are in the repo, so commit them to share ${basename(commandDest)} with the team.\n`
    );
  }
}

main();
