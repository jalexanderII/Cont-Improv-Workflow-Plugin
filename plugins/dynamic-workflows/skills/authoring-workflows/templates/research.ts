/**
 * Shape: research a question across many sources, cross-check, report.
 *
 * This is the `/deep-research` equivalent. The value is not the fan-out, it's
 * the voting step: each claim is checked by independent agents that never saw
 * the agent that produced it, and claims that fail are dropped rather than
 * hedged. Claims that could not be checked are reported as unverified, not
 * treated as refuted.
 */

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "research",
  description: "Investigate a question across several angles and cross-check every claim",
  size: "large",
};

interface Args {
  /** The question to investigate. */
  question: string;
  /** How many independent angles to pursue. */
  angles?: number;
  /** How many verifiers vote on each claim. */
  voters?: number;
}

interface Claim {
  claim: string;
  source: string;
}

export default async function research({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const question = typeof args === "string" ? args : args.question;
  const angleCount = (typeof args === "string" ? undefined : args.angles) ?? 4;
  const voterCount = (typeof args === "string" ? undefined : args.voters) ?? 3;

  const plan = await phase("plan", () =>
    agentJSON<{ angles: string[] }>(
      `Break this research question into ${angleCount} independent angles of attack:\n\n` +
        `"${question}"\n\n` +
        `Each angle should be answerable on its own and should not overlap with the ` +
        `others. Prefer angles that could contradict each other, so disagreement ` +
        `surfaces instead of hiding.`,
      {
        type: "object",
        required: ["angles"],
        properties: { angles: { type: "array", items: { type: "string" } } },
      },
      { label: "decompose question", readOnly: true }
    )
  );

  const angles = plan?.angles ?? [question];

  const gathered = await phase("gather", () =>
    pipeline(angles, (angle) =>
      agentJSON<{ claims: Claim[] }>(
        `Research this angle of "${question}":\n\n${angle}\n\n` +
          `Search the web, read the primary sources you find, and extract specific ` +
          `factual claims. Every claim must carry the URL or document it came from. ` +
          `Do not include claims you could not source.`,
        {
          type: "object",
          required: ["claims"],
          properties: {
            claims: {
              type: "array",
              items: {
                type: "object",
                required: ["claim", "source"],
                properties: {
                  claim: { type: "string" },
                  source: { type: "string" },
                },
              },
            },
          },
        },
        { label: angle.slice(0, 70), readOnly: true }
      )
    )
  );

  const claims = gathered.flatMap((g) => g?.claims ?? []);
  if (claims.length === 0) return `No sourced claims found for: ${question}`;

  // Each claim gets several independent verifiers that never saw its author.
  const votes = await phase("verify", () =>
    pipeline(claims, (claim) =>
      pipeline(Array.from({ length: voterCount }, (_, i) => i), (voter) =>
        agentJSON<{ supported: boolean; reason: string }>(
          `Independently check this claim:\n\n"${claim.claim}"\n\n` +
            `Cited source: ${claim.source}\n\n` +
            `Verify it against the source and at least one other. Answer supported:false ` +
            `only if you find the claim contradicted or unsupported, not merely if you ` +
            `could not find corroboration.`,
          {
            type: "object",
            required: ["supported", "reason"],
            properties: {
              supported: { type: "boolean" },
              reason: { type: "string" },
            },
          },
          { label: `verify #${voter + 1}: ${claim.claim.slice(0, 50)}`, readOnly: true }
        )
      )
    )
  );

  const verified: Claim[] = [];
  const unverified: Claim[] = [];
  const refuted: Claim[] = [];

  claims.forEach((claim, i) => {
    const ballots = votes[i].filter((v) => v !== null);
    if (ballots.length === 0) {
      // Every verifier errored out: unknown, not false.
      unverified.push(claim);
      return;
    }
    const support = ballots.filter((v) => v!.supported).length;
    if (support > ballots.length / 2) verified.push(claim);
    else refuted.push(claim);
  });

  const report = await phase("synthesize", () =>
    agent(
      `Write a report answering: "${question}"\n\n` +
        `Use ONLY these cross-checked claims:\n${JSON.stringify(verified, null, 2)}\n\n` +
        (unverified.length > 0
          ? `These claims could not be checked and must be listed separately as ` +
            `unverified, never mixed into the main findings:\n` +
            JSON.stringify(unverified, null, 2) +
            `\n\n`
          : "") +
        `Cite the source URL inline for every claim. Where the sources disagree, say so ` +
        `rather than picking a side. Do not add anything not present in these claims.`,
      { label: "final report", readOnly: true }
    )
  );

  return (
    `${report ?? "Report generation failed."}\n\n---\n` +
    `${angles.length} angles, ${claims.length} claims gathered, ${verified.length} verified, ` +
    `${refuted.length} dropped after cross-checking, ${unverified.length} unverified.`
  );
}
