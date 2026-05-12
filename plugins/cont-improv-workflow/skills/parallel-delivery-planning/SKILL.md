---
name: parallel-delivery-planning
description: Structures work for parallel developers — dependency ordering, prefixed distributable task lists, and an explicit DAG so multiple people can execute in parallel safely. Use when planning multi-person delivery, splitting workstreams, or when the user needs task batches and execution order.
metadata:
  disable-model-invocation: "true"
---

# Parallel delivery planning

Structure work to maximize safe parallelism across developers when possible.

## Output shape

1. **Prefixed todos** — Use a clear prefix per workstream (for example `A-`, `B-`, `C-` or feature names) so tasks can be assigned without ambiguity.
2. **DAG / dependency tree** — End with a dependency graph or ordered phases: what must finish before what, and which tasks are independent and can run in parallel.
3. **Distribution hints** — Note which prefixed batch each person or agent can own with minimal merge conflict risk.

## Framing

- Prefer many small independent tasks over one large critical path when the problem allows it.
- Call out shared surfaces (schema, API contracts, design tokens) as serialization points — those merge first, then parallel feature work.
