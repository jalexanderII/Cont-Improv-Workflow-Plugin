---
name: workflow-local
description: >-
  Run a structured fan-out inside this session using Task subagents, for
  roughly 3-15 independent units of work. No script, no separate process, no
  API key, no extra billing.
---

# Workflow (local)

Run a structured fan-out **inside this session** using `Task` subagents. No
script, no separate process, no API key, no extra billing.

Use when the user says "/workflow-local", or when a task decomposes into roughly
3-15 independent units and doesn't justify launching the full runtime.

## How this differs from /workflow

Subagent results come back through **your** context window. That's the hard
limit: past a dozen or so workers you'll run out of room, and there's no
progress view beyond what you narrate. If the task is bigger than that, or the
user wants to watch it, use `/workflow` instead.

## Steps

**1. Name the unit of work.** Files, endpoints, tests, sources. Enumerate them
concretely before delegating anything — with `git diff --name-only`, a glob, or
a grep. Do not have a subagent guess the list if you can compute it.

**2. Check the size.** More than ~15 units, or units needing deep per-item
exploration: stop and recommend `/workflow`. Say why, in one line.

**3. Fan out.** One `workflow-worker` subagent per unit, launched in parallel.
Give each one exactly its unit and ask for a compact structured result. Workers
are read-only unless the task genuinely requires edits.

**4. Verify, when the output is findings or claims.** Launch `workflow-verifier`
subagents against the collected findings, each one seeing the claim but not its
author, and asked to disprove it. Keep what survives. Report anything the
verifier couldn't check as unverified — not as refuted. This step is most of the
quality difference between a fan-out and just asking once.

Skip verification when the output is mechanical (a file list, a rename) rather
than a judgment.

**5. Synthesize.** Hand everything to one `workflow-synthesizer` subagent to
deduplicate by underlying cause, rank by real consequence, and produce a single
report. Don't paste raw per-worker output into the conversation.

The `workflow-worker`, `workflow-verifier`, and `workflow-synthesizer` subagent
types ship with this plugin; select them by name.

**6. Report.** Lead with the most important finding. Give the counts: units
examined, findings raised, findings confirmed.

## Rules

- Never let two writers share a working copy. If more than one unit needs edits
  to the same area, do them sequentially or switch to `/workflow`, which
  isolates writers in git worktrees.
- If a worker fails, note it and continue. Do not retry in a loop and do not
  silently drop it from the count.
- Don't invent findings to fill out a thin report. An empty result is a result.
