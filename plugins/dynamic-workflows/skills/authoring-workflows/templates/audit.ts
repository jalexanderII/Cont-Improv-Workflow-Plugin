/**
 * Shape: audit many files for the same issue.
 *
 * One agent per file, then an independent adversarial pass that tries to
 * disprove each finding before it reaches the report. The verification pass is
 * what makes this more trustworthy than a single agent reading everything.
 */

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "audit",
  description: "Audit every file matching a glob for a specific issue",
  size: "large",
};

interface Args {
  /** Glob or directory to audit, e.g. "src/routes/**\/*.ts". */
  target: string;
  /** What to look for, e.g. "missing authentication checks". */
  issue: string;
}

interface Finding {
  file: string;
  line?: number;
  severity: "high" | "medium" | "low";
  claim: string;
  evidence: string;
}

export default async function audit({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const { target, issue } = args;

  const discovered = await phase("discover", () =>
    agentJSON<{ files: string[] }>(
      `List every file matching ${target}. Return paths relative to the repository root.`,
      {
        type: "object",
        required: ["files"],
        properties: { files: { type: "array", items: { type: "string" } } },
      },
      { label: `discover ${target}`, readOnly: true }
    )
  );

  const files = discovered?.files ?? [];
  if (files.length === 0) return `No files matched ${target}.`;

  const audited = await phase("audit", () =>
    pipeline(files, (file) =>
      agentJSON<{ findings: Finding[] }>(
        `Audit ${file} for ${issue}.\n\n` +
          `Report only what you can point at in the file. Quote the exact code as evidence. ` +
          `If the file is clean, return an empty findings array.`,
        {
          type: "object",
          required: ["findings"],
          properties: {
            findings: {
              type: "array",
              items: {
                type: "object",
                required: ["file", "severity", "claim", "evidence"],
                properties: {
                  file: { type: "string" },
                  line: { type: "number" },
                  severity: { type: "string", enum: ["high", "medium", "low"] },
                  claim: { type: "string" },
                  evidence: { type: "string" },
                },
              },
            },
          },
        },
        { label: file, readOnly: true }
      )
    )
  );

  const findings = audited.flatMap((r) => r?.findings ?? []);
  if (findings.length === 0) return `No ${issue} found across ${files.length} files.`;

  // Independent agents, no knowledge of who produced the claim.
  const verdicts = await phase("verify", () =>
    pipeline(findings, (finding) =>
      agentJSON<{ upheld: boolean; reason: string }>(
        `A reviewer claims ${finding.file} has this problem: "${finding.claim}"\n\n` +
          `Their evidence:\n${finding.evidence}\n\n` +
          `Read the file yourself and try to disprove the claim. Consider whether the ` +
          `concern is handled elsewhere (middleware, decorators, a wrapper, a caller). ` +
          `Uphold it only if it survives that scrutiny.`,
        {
          type: "object",
          required: ["upheld", "reason"],
          properties: {
            upheld: { type: "boolean" },
            reason: { type: "string" },
          },
        },
        { label: `verify ${finding.file}: ${finding.claim.slice(0, 40)}`, readOnly: true }
      )
    )
  );

  const upheld = findings.filter((_, i) => verdicts[i]?.upheld === true);
  const unverified = findings.filter((_, i) => verdicts[i] === null);

  const report = await phase("synthesize", () =>
    agent(
      `Write an audit report for "${issue}" across ${files.length} files.\n\n` +
        `Confirmed findings (survived independent adversarial review):\n` +
        JSON.stringify(upheld, null, 2) +
        `\n\nRank by severity and blast radius, group related findings, and give a ` +
        `one-line fix for each. Do not invent findings that are not in this list.`,
      { label: "final report", readOnly: true }
    )
  );

  const notes = [
    `${files.length} files audited, ${findings.length} raw findings, ${upheld.length} confirmed.`,
    findings.length - upheld.length - unverified.length > 0
      ? `${findings.length - upheld.length - unverified.length} refuted during verification.`
      : "",
    unverified.length > 0
      ? `${unverified.length} could not be verified (agent failure) and are excluded.`
      : "",
  ].filter(Boolean);

  return `${report ?? "Report generation failed."}\n\n---\n${notes.join(" ")}`;
}
