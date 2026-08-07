---
name: running-workflows
description: >-
  The operating procedure for launching any dynamic workflow: credentials,
  cost confirmation, launching, giving the user visibility, polling, reporting
  honestly, and saving a run for reuse. Use whenever running a saved workflow
  command, launching a script with the wf runner, or when a workflow command
  defers here for the standard steps.
---

# Running a workflow

This is the standard procedure for launching **any** workflow. Individual
workflow commands describe only what is specific to them — what the script
does, its arguments, and its expected scale — and defer here for everything
else. Don't duplicate this into a command file.

Runner: the `wf` script in this plugin's `authoring-workflows` skill directory.

## 1. Preflight

```bash
test -x ~/.cursor/workflows-runtime/deps/node_modules/.bin/tsx || wf bootstrap "$PWD"
wf auth
```

`wf auth` reports the credential it would use and where it came from. If it
finds none it prints the options; relay them and stop rather than launching.

Recommend `wf login` over exporting `CURSOR_API_KEY`. An export only exists in
the shell that ran it, so a user who exports it in their own terminal has not
made it visible to a run you launch — that mismatch looks like a bug. A stored
login works from any shell or process and never lands in a repo.

Never ask a user to paste a key into chat, and never write one into a file in
their repository.

## 2. Confirm before spending

Say how many agents the run will spawn and roughly how long it will take, and
wait for the user to agree. Offer a cheaper configuration for a first look.

Workflow usage bills separately from the IDE session. There is no per-run
approval card in Cursor, so this confirmation is the main thing standing
between a mistaken argument and hundreds of agents.

For an unfamiliar or newly written script, dry-run it first — `--dry-run`
stubs every agent, costs nothing, and validates the whole control flow in
seconds.

## 3. Launch detached

```bash
wf tmux <script> --args '<json>'
```

Use `tmux`, not `run`, for anything that will outlive the turn.

## 4. Give visibility immediately

Every time, unasked, in the same message as the launch. A background run the
user cannot see is a black box.

`wf tmux` prints a "How to watch this run" block with the dashboard URL, the
attach command, the peek command, and the run id.

1. **Paste that block verbatim.** Don't summarize it or drop the tmux lines
   because you also opened the dashboard.
2. **Open the dashboard** with the `cursor-app-control` MCP tool
   `open_resource`, passing the URL as `uri`.
3. One line on what's running and the rough duration.

`wf watch-info <runId>` reprints the block if you need it later.

**Never run `tmux attach` yourself.** It fails: the agent shell is `TERM=dumb`
and tmux refuses to attach to a non-TTY. That command is for the user's
terminal. Use `tmux capture-pane -pt <session>` when you want to look; that
works and returns the rendered view.

## 5. Poll while it runs

Use `wf show <runId>` rather than attaching. Summarize phase, agents done out
of total, failures, and tokens. Don't paste raw pane output, and don't
re-print identical numbers — if nothing changed, say so.

Long silences are normal in phases whose agents do heavy work like web
research. Confirm progress by watching the token count move.

## 6. Report

Give the result, then the run's shape in one line: units examined, findings,
how many survived verification, how many failed.

Open the canvas with `open_resource` using the `file://` path from `wf show`,
and include the markdown link so the user can reopen it.

### Honesty rules

- Anything the workflow marks **unverified** is unknown — not confirmed, not
  refuted. Report it separately; never fold it into the verified findings.
- **Report failed agents** in the totals. A report built from 12 findings while
  8 agents errored is not the same as a clean run.
- If **nothing was dropped** during cross-checking, say so plainly. It means
  the verification step ran without disagreeing, not that the claims are
  certain.
- The token total sums input, output, and cache reads, so it overstates spend
  on runs with heavy prompt caching. Don't quote it as a bill.
- Never present output as more certain than the verification pass supports.

## 7. Offer to save it

If the run did what the user wanted and the task is one they'd repeat, offer
`wf save <runId> --name <name>`, which turns it into `/<name>` for any future
chat. Offer; don't save automatically. A one-off doesn't need a command.

## Troubleshooting

| Symptom | What's happening |
| --- | --- |
| Dashboard stuck on "running" | The server exits with the run. `wf show` is the truth; the run is almost certainly finished |
| Dashboard URL not responding | The run ended and the linger window passed. Use the canvas |
| Every agent fails instantly | No usable credential. `wf auth` |
| Run finished suspiciously fast | Check for `cached` agents — that's a resume, not a fresh run |
| Run shows `abandoned` | The process died, usually a closed terminal. `wf resume <runId>` |

## Re-running versus resuming

Launching a workflow again is a real new run that redoes the work. Only
`wf resume <runId>` reuses previous results, and only from that run's own
cache. Don't tell a user a re-run will be cheap because of caching.
