# Dynamic Workflows

Orchestrate many Cursor subagents from a script the agent writes and you can
rerun. A Cursor plugin — no changes to the editor or any codebase.

This recreates [Claude Code's dynamic workflows](https://code.claude.com/docs/en/workflows)
using only plugin surfaces: skills, subagents, commands, a rule, a hook, and a
TypeScript runtime built on `@cursor/sdk`.

This directory **is** the plugin root (`.cursor-plugin/`, `commands/`, `agents/`,
`rules/`, `hooks/`, `skills/`, `workflows/`). Layout matches
[Cursor plugins](https://cursor.com/docs/plugins). In this repository the plugin
lives at **`plugins/dynamic-workflows/`**, and every path below is relative to
that directory.

## The idea

The orchestration lives in **code**, not in a context window. Loops, branching,
and intermediate results stay in script variables, so a 500-file audit returns
one report to the conversation instead of 500 transcripts. The script is also
the artifact: readable, diffable, and rerunnable.

## Two modes

| | `/workflow` | `/workflow-local` |
| --- | --- | --- |
| Runs | Separate process, via `@cursor/sdk` | Inside the session, via `Task` |
| Scale | Hundreds of agents | Roughly 3-15 |
| Results live in | Script variables | Your context window |
| Progress view | Terminal, HTTP, canvas | Whatever the agent narrates |
| Needs `CURSOR_API_KEY` | Yes, billed separately | No |
| Resumable | Yes | No |

Use `/workflows` to list, watch, stop, and resume runs.

## Install (local)

1. Symlink this plugin directory into your local plugin folder, from the repo root:

   ```bash
   ln -sf /absolute/path/to/repo/plugins/dynamic-workflows ~/.cursor/plugins/local/dynamic-workflows
   ```

2. Restart Cursor or run **Developer: Reload Window**.

The symlink target must be **`plugins/dynamic-workflows`**, not the repo root, so
`.cursor-plugin/plugin.json` resolves correctly.

## Getting started

Run these once, from the project the workflows should operate on. `PLUGIN` is
this directory — `plugins/dynamic-workflows` in this repo, or
`~/.cursor/plugins/local/dynamic-workflows` once installed:

```bash
PLUGIN=~/.cursor/plugins/local/dynamic-workflows
"$PLUGIN"/skills/authoring-workflows/bootstrap.sh "$PWD"
"$PLUGIN"/skills/authoring-workflows/wf login   # once; no env vars anywhere
```

`bootstrap.sh` takes the project directory as its argument and writes
`.cursor/workflows/_runtime.ts` there, so run it from the project root.

Dependencies install into `~/.cursor/workflows-runtime/deps`, never into your
repo.

`wf auth` shows which credential would be used. Resolution order is
`CURSOR_API_KEY`, then `~/.cursor/workflows-runtime/.env`, then the project's
`.env.local` / `.env`, then the stored login from `wf login`. Prefer the stored
login: an exported variable only exists in the shell that exported it, so a
terminal export is invisible to an agent-launched run.

Then just ask:

> use a workflow to audit every route handler under src/routes/ for missing
> authentication checks, and adversarially verify each finding before reporting it

Or run one directly. Workflows resolve by name from the project's
`.cursor/workflows/`, then the user's, then the ones bundled here:

```bash
"$PLUGIN"/skills/authoring-workflows/wf run deep-research --dry-run --args '{"question":"..."}'
```

Always `--dry-run` first. It stubs every agent, costs nothing, and validates the
whole control flow in about two seconds.

## What's inside

```
commands/          /workflow, /workflow-local, /workflows, /deep-research
workflows/         bundled workflows (deep-research)
skills/
  running-workflows/     how to run any workflow: auth, launch, visibility,
                         reporting, honesty rules — the single copy
  authoring-workflows/   the runtime, six templates, how to write a script
  workflow-progress/     choosing between terminal, HTTP, and canvas views
agents/            author, worker, verifier, synthesizer
rules/             read-only defaults, writer isolation, spend control
hooks/             launch gate: confirms real runs, lets dry runs through
```

Commands stay thin: they say what a workflow does and what arguments it takes,
and defer to `running-workflows` for the procedure. That skill is the only copy
of the launch, visibility, and reporting rules, so saved workflows never carry
a duplicate that drifts.

## Templates

`skills/authoring-workflows/templates/` has a working script for each shape in
the Claude Code docs: `audit`, `review-changed`, `fix-until-green`, `migrate`,
`research`, `saturate`.

Two patterns carry most of the quality: **adversarial verification** (hand each
finding to independent agents that never saw its author and ask them to
disprove it) and treating **unverified as unknown, not refuted**.

## Differences from Claude Code

**Better:** resume is content-addressed, so only genuinely unfinished agents
re-run. Claude replays in start order and re-runs everything after the first
incomplete agent even if it had finished. The cache is scoped to a single run,
so re-running a workflow does the work again — only `wf resume` reuses results.

**Missing:** the `ultracode` keyword, which needs model-level integration. Ask
for a workflow in plain language instead — the skill triggers on "use a
workflow" and similar.

**Different:** instead of a per-run approval card listing phases, you get a
launch-gate hook plus the agent showing you the plan before it spends anything.

## Costs

Workflow agents authenticate with `CURSOR_API_KEY` and are billed separately
from your IDE session. Runs default to 16 concurrent agents and cap at 1000 per
run. Stopping is cheap — completed agents stay cached.
