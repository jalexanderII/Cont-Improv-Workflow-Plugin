---
name: workflow-progress
description: >-
  Choose and use the right progress view for a running or finished workflow —
  terminal/tmux, the live HTTP dashboard, or the final canvas. Use when the user
  asks to watch, monitor, or check on a workflow run, wants a dashboard or
  report for one, or asks why a canvas can't update live.
---

# Watching a workflow run

Three views, backed by the same append-only event log. Pick by what the user is
actually doing.

| View | Live? | Best for |
| --- | --- | --- |
| Terminal / tmux | Yes | The default. Free, always available, readable by you and the user |
| HTTP dashboard | Yes | Large runs, or watching after the chat has moved on |
| Canvas | No | The final report as a shareable artifact |

## Terminal, via tmux

The default for anything that outlives a turn. `wf tmux` starts the run
detached, so the turn can end without killing it:

```bash
<skill-dir>/wf tmux .cursor/workflows/audit.ts --args '{"target":"src"}'
```

It prints the session name. Read progress without stealing the user's terminal:

```bash
tmux capture-pane -pt <session>
```

The pane shows totals, per-agent status, elapsed time, and tokens, with running
agents sorted to the top. It stays open after the run so the report remains
readable.

## HTTP dashboard

Every run starts one on loopback automatically and records the URL. Retrieve it
with `wf show <runId>`, or suppress it with `--no-server`.

Reach for this when the run is too big for a terminal pane (more than ~25
agents), or when the user wants to keep watching after the conversation moves
on. It polls once a second and groups agents by phase, with failures inline.

**It lives and dies with the run.** The server belongs to the run's process, so
it stays up for `--linger` seconds after the run ends (90 by default) and then
exits. The linger is what lets the page poll once more and render the finished
frame rather than freezing on whatever it last saw mid-run. After that the URL
stops responding, and the page says so and points at `wf show` and the canvas.
If a user reports the dashboard "stuck on running", check `wf show` first: the
run is almost certainly finished and the page simply lost the server.

It binds to `127.0.0.1` only, because run state contains repo paths and prompt
text.

## Canvas

**A canvas cannot poll a live run.** Canvases embed their data inline and are
forbidden from making network calls, so there is no way for one to fetch state
while a workflow is in flight. Don't promise a live canvas.

What a canvas is genuinely good at is the **finished** run: the report, the
totals, failures, and a per-phase agent breakdown, as one self-contained
artifact the user can keep and share. Every run emits one automatically unless
`--no-canvas` is passed, and `wf show <runId>` prints its path.

There is one way to get live-ish updates: the runner rewrites the `.canvas.tsx`
file, and the IDE recompiles on change. That's push-based rather than
pull-based, and it costs no agent turns because the runner writes the file
directly. It also churns the compiler on a timer, so it only makes sense for
small runs where the user specifically wants to watch inside the IDE. The
terminal or the dashboard is the better answer nearly every time.

## Give full visibility on launch — every time, unasked

A background run the user can't see is a black box. The moment you start one,
they must have both a view you opened for them and the commands to look
themselves. This is not something to do when asked; it is part of launching.

`wf tmux` prints a "How to watch this run" block containing the dashboard URL,
the attach command, the peek command, and the run id. Do exactly this:

1. **Paste that block verbatim** into your reply. Don't summarize it, don't
   drop the tmux lines because you also opened the dashboard, and don't
   reformat it into prose.
2. **Open the dashboard** with the `cursor-app-control` MCP tool
   `open_resource`, passing the URL as `uri`.
3. Say in one line what's running and roughly how long it should take.

All three, in the same message as the launch.

If you only have a run id, `wf watch-info <runId>` reprints the same block.

### Never run `tmux attach` yourself

It will fail. The agent shell runs with `TERM=dumb` and tmux refuses to attach
to a non-TTY, so the attempt wastes a step and then has to be explained. The
attach command is for the **user's** terminal, which is why you hand it over
rather than running it.

`tmux capture-pane -pt <session>` does work from your shell, and returns the
rendered view. Use that when you want to see the run yourself.

### After it finishes

The dashboard only exists while the run is live, so once it ends, open the
canvas the same way, passing its path as a `file://` URI. Canvases live under
`~/.cursor`, which `open_resource` is permitted to open. Include the markdown
link in your reply too, so they can reopen it later.

## Reporting progress in chat

When the user asks how a run is going, don't attach and paste a wall of output.
Read the state and summarize:

```bash
<skill-dir>/wf show <runId>
```

Give them the phase, how many agents are done out of the total, anything that
failed, and the token count. Include the dashboard URL or canvas path so they
can look themselves. If nothing has changed since last time, say that instead of
re-printing the same numbers.
