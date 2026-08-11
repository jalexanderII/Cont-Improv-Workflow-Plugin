---
name: parallel-delivery-planning
description: Structures work for parallel developers — dependency ordering, prefixed distributable task lists, and an explicit DAG so multiple people can execute in parallel safely. Use when planning multi-person delivery, splitting workstreams, or when the user needs task batches and execution order.
metadata:
  disable-model-invocation: "true"
---

# Parallel delivery planning

Structure work to maximize safe parallelism across developers.

## Output shape

1. **Prefixed todos** — a prefix per workstream (`A-`, `B-`, or feature names) so tasks assign unambiguously.
2. **Dependency graph** — ordered phases: what must finish before what, and which tasks are independent.
3. **Distribution hints** — which batch each person or agent can own with minimal merge conflict risk.

## Framing

- Prefer many small independent tasks over one long critical path.
- Shared surfaces (schema, API contracts, design tokens) are serialization points: they merge first, then parallel feature work.
