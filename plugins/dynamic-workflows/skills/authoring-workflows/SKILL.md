---
name: authoring-workflows
description: >-
  Write and run a dynamic workflow: a TypeScript script that orchestrates dozens
  to hundreds of Cursor subagents out of process, with live progress views and a
  final report. Use when a task is larger than one agent can hold in context,
  when the same step must run across many items, or when the user says
  "use a workflow", "run a workflow", "fan out", or invokes /workflow. Also use
  when saving a run as a reusable command or debugging a workflow script.
---

# Authoring dynamic workflows

A **workflow** is a TypeScript script that orchestrates subagents. You write the
script for the task the user describes; a runtime executes it in a separate
process while the chat session stays responsive.

The point is not "more agents". It's that **the orchestration lives in code**.
Loops, branching, and intermediate results stay in script variables, so a
500-file audit returns one report to the conversation instead of 500 transcripts.
That's also what makes the run repeatable: the script is the artifact.

## When a workflow is the right tool

Reach for one when:

- The task needs more agents than one conversation can coordinate.
- The same step repeats across many items (files, endpoints, tests, sources).
- You want a quality pattern that a single pass can't give you: independent
  agents adversarially checking each other's findings, or several angles on a
  question weighed against each other.
- The orchestration is worth keeping and rerunning.

Do **not** reach for one when a handful of `Task` subagents in the session would
do. For under ~10 delegated units, use `/workflow-local` instead: no process to
launch, no API key, no separate billing.

## Before you start

Run the bootstrap once per machine. It installs `@cursor/sdk` and `tsx` into
`~/.cursor/workflows-runtime/deps` — never into the user's repo, so no
`package.json`, lockfile, or `node_modules` in their project changes:

```bash
<skill-dir>/bootstrap.sh "$PWD"
```

It also writes `.cursor/workflows/_runtime.ts` into the project, a **type-only**
shim that gives generated scripts full editor types.

### Credentials

`wf auth` reports the credential it would use, and `wf login` sets one up
without any environment variables. The resolution order and the reasons behind
it live in `skills/running-workflows/SKILL.md`, which is also where the rest of
the launch procedure lives — preflight, cost confirmation, visibility,
reporting. Don't duplicate any of that into a workflow command.

One detail that matters when reading this runtime's code: when the credential
comes from the stored SDK login, the runner passes no `apiKey` at all and lets
the SDK resolve it, which keeps its expiry and backend-pairing checks intact.
Passing an explicit value, even an empty string, would bypass them.

## The script contract

A workflow is a module with an optional `meta` and a default-exported async
function. The runner injects the helpers as its single argument, so the script
imports nothing at runtime and stays portable:

```typescript
import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "audit-routes",
  description: "Audit every route handler for missing auth checks",
};

export default async function ({ agent, pipeline, phase, args }: WorkflowContext) {
  const files = await phase("discover", () =>
    agent("List every .ts file under src/routes/.", { readOnly: true }),
  );

  const audits = await phase("audit", () =>
    pipeline(files.split("\n"), (file) =>
      agent(`Audit ${file} for missing authentication checks.`, {
        label: file,
        readOnly: true,
      }),
    ),
  );

  return audits.filter(Boolean).join("\n\n");
}
```

Whatever the function returns becomes the report: printed to stdout, embedded in
the final canvas, and handed back to the conversation.

### The API

| Helper | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Spawns one subagent, resolves to its text or `null` on failure |
| `agentJSON<T>(prompt, schema, opts?)` | Same, but parses the reply against a JSON Schema |
| `pipeline(items, fn)` | Runs `fn` per item, bounded by the run's concurrency, results in input order |
| `phase(name, fn)` | Groups everything spawned inside under a named phase in the views |
| `args` | Whatever was passed at invocation time |
| `runAgents()` | The run's agent records, for scripts that report on themselves |

`agent()` options: `label`, `phase`, `model`, `readOnly`, `tools`,
`disallowedTools`, `cwd`, `cache`.

`model` takes either a catalog id or a full selection. Effort and speed are
model *parameters*, not part of the id:

```ts
await agent(prompt, { model: "composer-2.5" });
await agent(prompt, {
  model: { id: "grok-4.5", params: [{ id: "effort", value: "high" }] },
});
```

Omit `params` to get the model's own default variant.

Prefer `agentJSON` over `agent` whenever the result feeds back into script
logic. Parsing prose to decide what to do next is where workflows break.

## Tool posture: decide it per phase

Every agent gets the standard toolset by default, matching how Claude Code runs
workflow subagents. That is the right default for migrations and fix loops, and
the wrong one for everything else.

- **`readOnly: true`** drops `edit` and `shell`. Use it for every discovery,
  audit, review, verification, and synthesis phase. These phases have no reason
  to write, and a fan-out of 50 writers is a lot of blast radius.
- **Writers get their own `cwd`.** When many agents edit concurrently, give each
  one a git worktree (see `templates/migrate.ts`). Agents sharing a working copy
  will clobber each other.

A good workflow is usually read-only except for one clearly marked phase.

## Six shapes that cover most tasks

`templates/` holds a working script for each. Copy the closest one and adapt it
rather than starting from scratch.

| Template | Shape |
| --- | --- |
| `audit.ts` | One agent per file, then adversarial verification of each finding |
| `review-changed.ts` | One reviewer per changed file, merged into one ranked summary |
| `fix-until-green.ts` | Run a check, fix failures, repeat until it passes or stalls |
| `migrate.ts` | Transform each file in its own worktree, verify, apply what passed |
| `research.ts` | Fan out angles, gather sourced claims, vote on each, cited report |
| `saturate.ts` | Search in rounds until consecutive rounds find nothing new |

Two patterns worth stealing from them:

**Adversarial verification.** Don't report what one agent claims. Hand the claim
to independent agents that never saw its author and ask them to disprove it.
Report what survives. This is most of the quality difference between a workflow
and a big prompt.

**Unverified is not refuted.** When a verifier errors out, the claim is unknown,
not false. Report it separately instead of silently dropping it.

## Running one

Save the script to the project's `.cursor/workflows/`, then:

```bash
<skill-dir>/wf run .cursor/workflows/audit-routes.ts --args '{"target":"src/routes"}'
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Stub every agent. No network, no spend. Validates control flow |
| `--args <json>` | Value exposed to the script as `args` |
| `--concurrency <n>` | Simultaneous agents, default 16 |
| `--cap <n>` | Hard ceiling on total agents, default 1000 |
| `--fresh` | Ignore the resume cache |
| `--model <id>` | Catalog model id for every agent |
| `--param <id=value>` | Model parameter, repeatable: `--param effort=high` |
| `--no-server` / `--no-canvas` | Skip the live view / final canvas |
| `--linger <seconds>` | Keep the dashboard up after the run ends |
| `--json` | Machine-readable summary only |

`--model` takes a **catalog id only**. Effort and speed are separate parameters,
so Grok at high effort with fast enabled is:

```bash
wf run <script> --model grok-4.5 --param effort=high --param fast=true
```

not `--model cursor-grok-4.5-high-fast`, which is a UI slug the backend rejects.
`WORKFLOW_MODEL` and `WORKFLOW_MODEL_PARAMS` (`effort=high,fast=true`) set the
same two defaults from the environment.

`--linger` exists because the dashboard is served by the run's own process, so
it dies the instant the run ends and a page whose last poll landed mid-run
freezes showing "running". It defaults to 0 for `wf run`, whose terminal
already shows the final state, and `wf tmux` sets 90 because a detached run's
only live view is the dashboard.

**Always `--dry-run` a new script first.** It exercises discovery, fan-out,
branching, and synthesis in about two seconds and catches the errors that would
otherwise cost real tokens to find.

For anything long-running, use `wf tmux` instead of `wf run` so the run survives
the turn and both you and the user can read it:

```bash
<skill-dir>/wf tmux .cursor/workflows/audit-routes.ts --args '...'
tmux capture-pane -pt <session>   # read progress without attaching
```

## Cost

A workflow can spend meaningfully more than doing the task in conversation. To
size it before committing:

1. `--dry-run` to confirm the shape and see how many agents it will spawn.
2. Run against one directory before the whole repo.
3. Watch the token counter in any progress view and stop if it runs away.

Stopping is cheap: completed agents are content-addressed inside the run's own
directory, so `wf resume <runId>` re-runs only what never finished, in any
order. Prefer many small agents over a few long ones — they preserve far more
progress.

The cache is scoped to a single run. Launching the same workflow again with the
same arguments is a genuinely new run that re-does the work; only `wf resume`
reads a previous run's results. Anything else would make a re-run silently
replay stale answers, which is exactly wrong for research.

Route cheap phases to a smaller model with `{ model: "..." }` rather than
running everything on the session default.

## Saving a workflow for reuse

When a run does what the user wanted, offer to save it. One command turns it
into a slash command they can invoke in any future chat:

```bash
wf save <runId> [--name <name>] [--personal]
```

That writes two files: the script into a workflows directory, and a command
file that makes it invocable as `/<name>`. The command file is generated with
the preflight, the argument shape from that run, the visibility rules, and the
honesty rules already in it — the same structure as the bundled research
command.

Two locations, matching Claude Code's split:

- **project** (default): `.cursor/workflows/` and `.cursor/commands/`, checked
  in and shared with everyone who clones the repo. Paths in the generated
  command are repo-relative so they resolve for any clone.
- **personal** (`--personal`): `~/.cursor/workflows/` and `~/.cursor/commands/`,
  available in every project and visible only to that user. Paths are absolute.

The name defaults to the workflow's `meta.name`. Pass `--name` to override, and
`--force` to overwrite an existing command of the same name.

Proactively suggest this after a successful run of a workflow the user is
likely to repeat — a review they run on every branch, an audit they run each
release. Don't save automatically; a one-off task doesn't need a command.

## Reading what a subagent actually did

The progress views show a subagent's status, timing, and a preview of its
answer. The dashboard also has the whole thing: every agent row that produced a
transcript gets a **View** link to `/agent/<n>`, a page with that subagent's
prompt, its reasoning, and each tool call with the arguments it passed and the
result it got back. Failed tool calls are expanded on arrival; the rest collapse.

Each transcript is its own tab, because comparing subagents is usually the
point — three verifiers that disagreed, or a worker against the synthesizer that
consumed it, want to be open side by side. The page is plain server-rendered
HTML with no JavaScript, so Cmd+S saves a working copy, and `/agent/<n>.json`
returns the same data for anything scripting against a live run.

This is a local read of the SDK's own agent store — no network and no spend, so
opening a transcript costs nothing. It is the fastest way to answer "why did
this agent conclude that?", and a failed agent's transcript is usually the one
worth reading first.

Two agents have no transcript: a dry-run agent, which never ran, and an agent
that failed before it started, such as one given a model id the backend rejects.
Their rows simply have no link.

The dashboard is served by the run's own process, so transcripts are reachable
only while it is alive — `--linger` extends that window.

## Retention

Transcripts are large — a single tool-heavy agent can persist tens of megabytes,
and a fan-out makes dozens at once — so they expire on their own.

| Command | Effect |
| --- | --- |
| `wf prune` | Delete transcripts past the TTL |
| `wf prune --days <n>` | Use a different cutoff for this pass |
| `wf prune --all` | Delete every stored transcript this runtime created |
| `wf prune --dry-run` | Report what would go, delete nothing |
| `wf clean [--days <n>]` | Delete old run directories, pruning their transcripts first |

The default TTL is **7 days**, set with `WORKFLOW_TRANSCRIPT_TTL_DAYS`.
`WORKFLOW_TRANSCRIPT_TTL_DAYS=off` disables the automatic pass and leaves
`wf prune` available on demand.

Pruning runs itself at most once a day when a run starts, in the background, and
never fails a run. Once a transcript is gone its agent row says `expired`, which
is deliberately distinct from an agent that never had one.

The agent store is shared with everything else that uses the Cursor SDK in the
same workspace, so pruning only ever removes agents this runtime recorded a run
id for, and always through the SDK, which keeps its index and the per-agent blob
directories consistent. Agents created by other tools are never touched.

## Debugging

- `wf list` — every run, status, agent counts, tokens
- `wf show <runId>` — full detail including each failed agent's error
- `wf watch <runId>` — follow a live run
- `wf stop <runId>` — SIGTERM, so the runner records the stop and flushes state
- The dashboard's **View** link — a subagent's full prompt, reasoning, and tool calls
- Raw event log: `~/.cursor/workflows-runtime/runs/<runId>/events.jsonl`

Common failures and what they mean:

| Symptom | Cause |
| --- | --- |
| Every agent errors immediately | `CURSOR_API_KEY` missing or invalid |
| `agentJSON` returns `null` | Model returned prose; tighten the schema and the instruction |
| Fan-out finds nothing | Discovery phase returned an empty list; check its prompt in `wf show` |
| Edits conflict or vanish | Concurrent writers sharing one `cwd`; give each a worktree |
| Run never terminates | A loop without a stall detector; add one, and lower `--cap` |
