/**
 * Shape: migrate many files in parallel without edit conflicts.
 *
 * Each file is transformed inside its own git worktree, so N agents editing
 * concurrently never touch the same working copy. The worktrees are created by
 * the script rather than by an agent: it's deterministic plumbing, and a shell
 * command that must succeed is not a good use of a model.
 *
 * Patches move between worktrees as raw bytes on disk, never as strings. See
 * `capturePatch` — decoding or trimming a diff destroys it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "migrate",
  description: "Migrate every matching file in an isolated worktree, then verify",
  size: "large",
};

/** A migration touching a generated lockfile or schema snapshot outgrows the 1MB default. */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

interface Args {
  /** Files to migrate, e.g. "src/components/**\/*.tsx". */
  target: string;
  /** The transformation, e.g. "styled-components to Tailwind". */
  migration: string;
  /** Optional per-file verification command, e.g. "npx tsc --noEmit". */
  verify?: string;
}

/**
 * `no-diff` is deliberately not `failed`: an agent that reports success while
 * changing nothing is a distinct signal — usually the migration didn't apply to
 * that file, occasionally the agent edited somewhere the diff can't see it.
 * Folding it into either "migrated" or "failed" hides which one happened.
 */
type Outcome = "patched" | "no-diff" | "failed";

interface FileResult {
  file: string;
  outcome: Outcome;
  note: string;
  /** Patch bytes on disk. Lives outside the worktree so it outlives cleanup. */
  patchFile?: string;
  /** The worktree the patch came from, kept when applying it failed. */
  worktree?: string;
}

/**
 * Git output meant to be read: identifiers, statuses, confirmations. Trimmed
 * because a trailing newline is noise in a report. Never use this for a diff.
 */
function gitText(cwd: string, ...cliArgs: string[]): string {
  return execFileSync("git", cliArgs, { cwd, encoding: "utf8" }).trim();
}

/**
 * The worktree's changes as a patch, as raw bytes.
 *
 * Returned as a Buffer and never trimmed or decoded, both of which corrupt a
 * diff. Trimming is the worse one: a blank context line in a unified diff is
 * encoded as a single space, so trailing whitespace *is* content, and trimming
 * deletes the final line outright. The hunk then has fewer lines than its
 * header promises and `git apply` rejects the whole patch as `corrupt patch at
 * line N`, pointing at the last hunk rather than at the capture. Decoding is
 * the quieter one: a UTF-8 round-trip rewrites any byte that isn't valid UTF-8,
 * such as a binary delta or a latin-1 source file. `git add -A` first so files
 * the agent *created* are in the diff too; `git diff HEAD` omits untracked ones.
 */
function capturePatch(cwd: string): Buffer {
  execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  return execFileSync("git", ["diff", "--binary", "--cached", "HEAD"], {
    cwd,
    maxBuffer: MAX_PATCH_BYTES,
  });
}

/**
 * Applies a patch file to `repo`, from disk rather than stdin so the bytes are
 * never re-encoded on the way in. `--check` runs first: a patch that only
 * partly applies leaves the shared tree in a state nobody asked for.
 */
function applyPatch(repo: string, patchFile: string): void {
  const args = ["apply", "--binary", "--whitespace=nowarn"];
  execFileSync("git", [...args, "--check", patchFile], { cwd: repo, stdio: "pipe" });
  execFileSync("git", [...args, patchFile], { cwd: repo, stdio: "pipe" });
}

function gitErrorText(err: unknown): string {
  const { stderr } = err as { stderr?: Buffer | string };
  const text = stderr === undefined ? String(err) : stderr.toString();
  return text.trim().split("\n")[0] ?? "git apply failed";
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
    : gitText;

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
  // Worktrees whose patch never made it into the main tree. Removing one would
  // destroy the only copy of that agent's work.
  const keep = new Set<string>();

  try {
    const results = await phase("migrate", () =>
      pipeline<string, FileResult>(files, async (file, index) => {
        const dir = join(base, String(index));
        try {
          git(repo, "worktree", "add", "--detach", dir, "HEAD");
          created.push(dir);
        } catch (err) {
          return { file, outcome: "failed", note: `worktree failed: ${String(err)}` };
        }

        const done = await agent(
          `In this worktree, migrate ${file}: ${migration}.\n\n` +
            `Change only ${file}. Preserve behavior exactly. If the migration ` +
            `doesn't apply to this file, make no changes and say so.`,
          { label: file, cwd: dir }
        );
        if (done === null) {
          return { file, outcome: "failed", note: "migration agent failed" };
        }

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
            return {
              file,
              outcome: "failed",
              note: check?.detail ?? "verification failed",
            };
          }
        }

        if (dryRun) {
          return { file, outcome: "patched", note: "[dry run] patch not captured" };
        }

        const patch = capturePatch(dir);
        if (patch.length === 0) {
          return {
            file,
            outcome: "no-diff",
            note: "agent reported success but changed nothing",
          };
        }

        const patchFile = join(base, `${index}.patch`);
        writeFileSync(patchFile, patch);
        return { file, outcome: "patched", note: "", patchFile, worktree: dir };
      })
    );

    // Apply only the migrations that verified, onto one branch in the main tree.
    const patched = results.filter((r) => r.outcome === "patched");
    const applied: FileResult[] = [];
    const conflicted: FileResult[] = [];
    if (patched.length > 0 && !dryRun) {
      git(repo, "checkout", "-b", branch);
      for (const result of patched) {
        if (result.patchFile === undefined) continue;
        try {
          applyPatch(repo, result.patchFile);
          applied.push(result);
        } catch (err) {
          if (result.worktree !== undefined) keep.add(result.worktree);
          conflicted.push({ ...result, note: gitErrorText(err) });
        }
      }
    }

    const noDiff = results.filter((r) => r.outcome === "no-diff");
    const failed = results.filter((r) => r.outcome === "failed");
    const migrated = dryRun ? patched : applied;
    return [
      dryRun ? "[dry run] no files were changed." : "",
      `Migrated ${migrated.length} of ${files.length} files: ${migration}`,
      migrated.length > 0 ? `Applied to branch ${branch}. Review before committing.` : "",
      conflicted.length > 0
        ? `\n${conflicted.length} could not be applied to the main tree. The work is ` +
          `intact — re-apply each patch by hand, or read the worktree:\n` +
          conflicted
            .map(
              (c) =>
                `  ${c.file} — ${c.note}\n` +
                `    patch:    ${c.patchFile}\n` +
                `    worktree: ${c.worktree} (kept)`
            )
            .join("\n")
        : "",
      noDiff.length > 0
        ? `\n${noDiff.length} produced no diff (nothing was applied for these):\n` +
          noDiff.map((n) => `  ${n.file} — ${n.note}`).join("\n")
        : "",
      failed.length > 0
        ? `\nFailed ${failed.length}:\n` +
          failed.map((f) => `  ${f.file} — ${f.note}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  } finally {
    for (const dir of created) {
      if (keep.has(dir)) continue;
      try {
        git(repo, "worktree", "remove", "--force", dir);
      } catch {
        // Leaving a stray worktree is better than masking the real error.
      }
    }
  }
}
