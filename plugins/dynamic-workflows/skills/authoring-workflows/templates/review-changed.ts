/**
 * Shape: review every changed file, then merge the findings into one summary.
 *
 * Per-file reviewers each see one file in full rather than a whole diff in
 * fragments; a single synthesizer then ranks and deduplicates, which is where
 * the "three reviewers all flagged the same thing" noise gets collapsed.
 */

import { execFileSync } from "node:child_process";

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "review-changed",
  description: "Review every file changed against a base ref, ranked into one summary",
  size: "medium",
};

interface Args {
  /** Base ref to diff against. Defaults to the merge-base with main. */
  base?: string;
  /** Extra emphasis, e.g. "focus on error handling and race conditions". */
  focus?: string;
}

interface Issue {
  file: string;
  line?: number;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export default async function reviewChanged({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const base =
    args?.base ??
    execFileSync("git", ["merge-base", "HEAD", "main"], { encoding: "utf8" }).trim();

  const files = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f !== "");

  if (files.length === 0) return `No files changed against ${base}.`;

  const focus = args?.focus ?? "correctness, error handling, and edge cases";

  const reviewed = await phase("review", () =>
    pipeline(files, (file) =>
      agentJSON<{ issues: Issue[] }>(
        `Review the changes to ${file} against ${base}.\n\n` +
          `Run \`git diff ${base} -- ${file}\` for the diff, then read the whole file ` +
          `for context. Focus on ${focus}.\n\n` +
          `Report only real problems in the changed lines. Style preferences, ` +
          `speculative refactors, and pre-existing issues outside the diff are noise.`,
        {
          type: "object",
          required: ["issues"],
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                required: ["file", "severity", "title", "detail"],
                properties: {
                  file: { type: "string" },
                  line: { type: "number" },
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                  title: { type: "string" },
                  detail: { type: "string" },
                },
              },
            },
          },
        },
        { label: file, readOnly: true }
      )
    )
  );

  const issues = reviewed.flatMap((r) => r?.issues ?? []);
  if (issues.length === 0) {
    return `Reviewed ${files.length} changed files against ${base}. No issues found.`;
  }

  const summary = await phase("synthesize", () =>
    agent(
      `Merge these per-file review findings into one ranked summary.\n\n` +
        JSON.stringify(issues, null, 2) +
        `\n\nDeduplicate issues that are the same underlying problem seen in several ` +
        `files, and say which files each affects. Rank by severity, then by how likely ` +
        `the problem is to actually bite. Lead with anything that would break in ` +
        `production. Do not add issues that are not in this list.`,
      { label: "ranked summary", readOnly: true }
    )
  );

  return (
    `${summary ?? "Synthesis failed."}\n\n---\n` +
    `${files.length} files reviewed against ${base}, ${issues.length} raw findings.`
  );
}
