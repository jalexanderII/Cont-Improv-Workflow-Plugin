---
name: deep-research
description: >-
  Investigate a question across several independent angles, cross-check every
  claim with adversarial verifiers, and return a cited report separating
  verified claims from unverified ones.
---

# Deep research

Investigate a question across several independent angles, cross-check every
claim, and return a cited report.

The user's question is whatever follows the command.

## Procedure

Follow `skills/running-workflows/SKILL.md` for preflight, cost confirmation,
launching, visibility, polling, reporting, and the honesty rules. Everything
below is specific to this workflow.

```bash
wf tmux deep-research --args '<json>'
```

`deep-research` resolves by name: a project's `.cursor/workflows/` first, then
the user's, then the copy bundled here. A project can shadow it by saving a
workflow under the same name.

## Arguments

```json
{ "question": "<the user's question>", "angles": 3, "voters": 3, "scope": "web" }
```

- **angles** — independent lines of attack. Default 3.
- **voters** — verifiers per claim. Default 3; keep it odd so the vote breaks.
- **scope** — `"web"` (default), or `"codebase"` when the question is about the
  current repository rather than the outside world.

## Scale

Defaults land around 35-50 agents and 4-8 minutes. `gather` dominates the wall
time because those agents do real web searches, so a phase sitting quiet for a
couple of minutes is normal — watch the token count, not the agent count.

Offer `{"angles":2,"voters":2}` for a quick look.

## Reading the result

The report separates verified claims from unverified ones and drops claims that
lost their vote. Beyond the standard honesty rules, one thing is specific here:
**the vote only means something with several voters.** At `voters: 1` it is a
single check, so describe it as "cross-checked by one independent reviewer"
rather than implying majority agreement.

## Local mode

If the invocation contains `local` or `--local`, run the same shape with `Task`
subagents in this session instead of the runtime. No credential, no dashboard,
no canvas, no resume — everything lands in your context, which sets the scale.

Follow `commands/workflow-local.md` for the general fan-out discipline, with
these research-specific adaptations:

- Decompose into **2-3** angles yourself rather than spending a subagent on it.
- One worker per angle, read-only, at most 5 sourced claims each.
- Deduplicate the claims yourself before verifying.
- One verifier per **batch of about 4 claims**, not per claim. That is a check,
  not a vote — say so.
- One synthesizer over the verified claims.

If the plan wants more than 3 angles, or the fan-out would exceed ~15
subagents, stop and recommend the runtime instead. Don't quietly start an
in-session run you'll run out of context to finish.
