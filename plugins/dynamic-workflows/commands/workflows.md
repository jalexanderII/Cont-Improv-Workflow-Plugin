---
name: workflows
description: >-
  List, inspect, watch, stop, and resume dynamic workflow runs, and save a
  finished run as a reusable slash command.
---

# Workflows

List, inspect, watch, stop, and resume workflow runs.

Use when the user says "/workflows", asks what's running, asks how a run is
going, or wants to stop or restart one.

## Commands

All of these go through the plugin's runner at
`skills/authoring-workflows/wf`:

```bash
wf list                  # every run: status, agents, tokens, elapsed
wf show <runId>          # full detail, including each failed agent's error
wf watch <runId>         # follow a live run until it finishes
wf stop <runId>          # SIGTERM, so the run records the stop and flushes state
wf resume <runId>        # relaunch, re-running only what never finished
wf save <runId>          # save the run's script as a reusable /command
wf clean --days 14       # drop old run directories
```

## Saving a run as a command

`wf save <runId> [--name <name>] [--personal]` writes the script into a
workflows directory and generates a command file, so the workflow becomes
`/<name>` in any future chat. Project location by default (checked in, shared);
`--personal` puts it under `~/.cursor` for that user only.

Offer this after a run the user is likely to repeat. Don't do it automatically.

## Reporting to the user

Summarize, don't dump. Give them the phase, agents done out of total, failures,
tokens, and the elapsed time. Include the live dashboard URL or the canvas path
so they can look for themselves. If nothing has changed since you last checked,
say so rather than re-printing identical numbers.

A run showing `abandoned` means the process died without finishing — usually the
terminal was closed. `wf resume` picks it up from the cache.

## Resume semantics

Completed agents are content-addressed by their prompt, model, tool posture, and
working directory, and cached **inside that run's own directory**. Resuming
continues under the same run id, so it re-runs only agents that never finished,
in any order. This is better than Claude Code's behavior, where replay follows
start order and everything after the first unfinished agent runs again even if
it had completed.

Because the cache is per-run, launching the same workflow again with the same
arguments is a real new run that does the work again. Only `wf resume` reuses
prior results. A shared cache would make a re-run finish instantly by replaying
stale answers, which looks like a bug and is dangerous for research.

Pass `--fresh` on a resume to ignore the cache when the underlying code has
changed and cached results would be stale.

## Stopping

`wf stop` is cheap. Completed work stays cached, so stopping a run that's
spending more than expected costs almost nothing. Recommend it freely when a
token count is climbing faster than the user expected.
