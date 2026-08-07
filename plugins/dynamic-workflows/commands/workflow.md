---
name: workflow
description: >-
  Run a task as a dynamic workflow: a script that orchestrates many subagents
  out of process, so the session stays responsive and only the final report
  comes back into context.
---

# Workflow

Run a task as a **dynamic workflow**: a script that orchestrates many subagents
out of process, so the session stays responsive and only the final report comes
back into context.

Use when the user says "/workflow", "use a workflow", "run a workflow", or
describes a task too large for one conversation to coordinate.

## Get a script

**1. Check for an existing workflow first.** Look in `.cursor/workflows/` and
`~/.cursor/workflows/`. If one already covers the task, run it with the user's
arguments instead of writing a new one.

**2. Write one.** Delegate to the `workflow-author` subagent with the task
description. It reads the authoring skill, picks the closest template, writes
the script to `.cursor/workflows/`, and dry-runs it. It returns the path, the
shape, and the projected agent count.

For a task that clearly matches a template and needs no adaptation, copy the
template yourself — but dry-run it either way. `--dry-run` stubs every agent,
costs nothing, and validates the whole control flow.

**3. Show the user the plan before spending anything.** The phases, the agent
count the dry run produced, the projected real count, and which phases can
write. Wait for confirmation.

## Run it

Follow `skills/running-workflows/SKILL.md` for preflight, launching,
visibility, polling, reporting, and the honesty rules. Don't restate those
steps here or in any command file — that skill is the single copy.

## Save it

If the run did what they wanted and it's a task they'd repeat, offer
`wf save <runId> --name <name>`, which turns it into `/<name>` for any future
chat. Offer; don't save automatically.

## Scope

`skills/authoring-workflows/SKILL.md` has the script contract, the injected
API, tool posture rules, and the six templates.

Under ~10 units of work, use `/workflow-local` instead: no process, no
credential, no separate billing.
