/**
 * Shape: migrate many files in parallel without edit conflicts.
 *
 * Each file is transformed inside its own git worktree, so N agents editing
 * concurrently never touch the same working copy. The worktrees are created by
 * the script rather than by an agent: it's deterministic plumbing, and a shell
 * command that must succeed is not a good use of a model.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "migrate",
  description: "Migrate every matching file in an isolated worktree, then verify",
  size: "large",
};

interface Args {
  /** Files to migrate, e.g. "src/components/**\/*.tsx". */
  target: string;
  /** The transformation, e.g. "styled-components to Tailwind". */
  migration: string;
  /** Optional per-file verification command, e.g. "npx tsc --noEmit". */
  verify?: string;
}

function gitReal(cwd: string, ...cliArgs: string[]): string {
  return execFileSync("git", cliArgs, { cwd, encoding: "utf8" }).trim();
}

export default async function migrate({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
  dryRun,
}: WorkflowContext<Args>): Promise<string> {
  const { target, migration, verify } = args;
  const repo = process.cwd();

  // A dry run stubs the agents, but git commands in this script body would
  // really run. Nothing here may touch the repository in that mode.
  const git = dryRun
    ? (_cwd: string, ...cliArgs: string[]) => `[dry run] git ${cliArgs.join(" ")}`
    : gitReal;

  const discovered = await phase("discover", () =>
    agentJSON<{ files: string[] }>(
      `List every file matching ${target} that still needs this migration: ${migration}. ` +
        `Skip files already migrated. Return paths relative to the repository root.`,
      {
        type: "object",
        required: ["files"],
        properties: { files: { type: "array", items: { type: "string" } } },
      },
      { label: `discover ${target}`, readOnly: true }
    )
  );

  const files = discovered?.files ?? [];
  if (files.length === 0) return `Nothing to migrate for ${target}.`;

  const base = mkdtempSync(join(tmpdir(), "wf-migrate-"));
  const branch = `wf/migrate-${Date.now()}`;
  const created: string[] = [];

  try {
    const results = await phase("migrate", () =>
      pipeline(files, async (file, index) => {
        const dir = join(base, String(index));
        try {
          git(repo, "worktree", "add", "--detach", dir, "HEAD");
          created.push(dir);
        } catch (err) {
          return { file, ok: false, note: `worktree failed: ${String(err)}` };
        }

        const done = await agent(
          `In this worktree, migrate ${file}: ${migration}.\n\n` +
            `Change only ${file}. Preserve behavior exactly. If the migration ` +
            `doesn't apply to this file, make no changes and say so.`,
          { label: file, cwd: dir }
        );
        if (done === null) return { file, ok: false, note: "migration agent failed" };

        if (verify !== undefined) {
          const check = await agentJSON<{ passed: boolean; detail: string }>(
            `Run \`${verify}\` in this worktree and report whether it passes.`,
            {
              type: "object",
              required: ["passed", "detail"],
              properties: {
                passed: { type: "boolean" },
                detail: { type: "string" },
              },
            },
            { label: `verify ${file}`, cwd: dir }
          );
          if (check?.passed !== true) {
            return { file, ok: false, note: check?.detail ?? "verification failed" };
          }
        }

        const patch = git(dir, "diff", "HEAD");
        return { file, ok: patch !== "", patch, note: patch === "" ? "no changes" : "" };
      })
    );

    // Apply only the migrations that verified, onto one branch in the main tree.
    const good = results.filter((r) => r.ok && r.patch !== undefined);
    if (good.length > 0 && !dryRun) {
      git(repo, "checkout", "-b", branch);
      for (const result of good) {
        execFileSync("git", ["apply", "-"], {
          cwd: repo,
          input: result.patch,
          encoding: "utf8",
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    return [
      dryRun ? "[dry run] no files were changed." : "",
      `Migrated ${good.length} of ${files.length} files: ${migration}`,
      good.length > 0 && !dryRun
        ? `Applied to branch ${branch}. Review before committing.`
        : "",
      failed.length > 0
        ? `\nSkipped ${failed.length}:\n` +
          failed.map((f) => `  ${f.file} — ${f.note}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  } finally {
    for (const dir of created) {
      try {
        git(repo, "worktree", "remove", "--force", dir);
      } catch {
        // Leaving a stray worktree is better than masking the real error.
      }
    }
  }
}
