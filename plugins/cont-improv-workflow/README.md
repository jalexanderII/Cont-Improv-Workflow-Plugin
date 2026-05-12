# Continuous Improvement Workflow

Cursor plugin for production-quality engineering workflows: always-on coding conventions, a pre-push review agent, and a planning skill for parallel delivery.

This directory **is** the plugin root (`.cursor-plugin/`, `rules/`, `skills/`, `agents/`). Layout matches [Cursor plugins](https://cursor.com/docs/plugins).

In this repository, the plugin lives at **`plugins/cont-improv-workflow/`**. The manifest **`displayName`** is **Continuous Improvement Workflow**; the package **`name`** is **`cont-improv-workflow`**.

## Contents

| Path | Purpose |
| --- | --- |
| `.cursor-plugin/plugin.json` | Manifest: `name` **cont-improv-workflow**, `displayName` **Continuous Improvement Workflow** |
| `rules/coding-conventions.mdc` | Always-on engineering conventions for production-ready implementation, review, testing judgment, architecture, and collaboration |
| `agents/pre-push-reviewer.md` | Final review agent for correctness, maintainability, security, performance, accessibility, and edge cases before pushing |
| `skills/parallel-delivery-planning/` | Planning skill for splitting work into independent batches with dependency ordering and ownership hints |

## How to use it

- Keep `rules/coding-conventions.mdc` installed as an always-applied rule so implementation and review share the same quality bar.
- Use `parallel-delivery-planning` when work needs to be split across multiple people or agents.
- Use `pre-push-reviewer` after implementation and checks, especially before pushing or opening a PR.

## Install (local)

1. Clone or open the **parent** repository (this file's repo root).

   ```bash
   ln -sf /absolute/path/to/repo/plugins/cont-improv-workflow ~/.cursor/plugins/local/cont-improv-workflow
   ```

2. Restart Cursor or run **Developer: Reload Window**.

The symlink target must be **`plugins/cont-improv-workflow`**, not the monorepo root, so `.cursor-plugin/plugin.json` resolves correctly.

## Org-specific fork (optional)

1. Copy `plugins/cont-improv-workflow` to a new folder (e.g. `plugins/cont-improv-workflow-acme`) or fork the repo and add a sibling under `plugins/`.
2. Edit `.cursor-plugin/plugin.json` (`name`, `displayName`, `description`) so the bundle is unique.
3. Add rules under `rules/` (e.g. `generated-workspace-context.mdc`) with org goals, repos, and terminology.

If you add a new plugin directory, register it in the repo root [`.cursor-plugin/marketplace.json`](../../.cursor-plugin/marketplace.json).
