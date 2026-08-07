/**
 * Deep research: investigate a question across many angles and cross-check
 * every claim before reporting it.
 *
 * The equivalent of Claude Code's bundled /deep-research. The fan-out isn't
 * what makes it trustworthy — the voting is. Each claim is checked by several
 * agents that never saw the agent that produced it, claims that lose the vote
 * are dropped, and claims nobody could check are reported as unverified rather
 * than quietly counted either way.
 *
 * Run:
 *   wf run deep-research --args '{"question":"..."}'
 *   wf run deep-research --args '"just the question"'
 */

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "deep-research",
  description: "Investigate a question across several angles, cross-check every claim, and return a cited report",
  size: "large",
};

type Args =
  | string
  | {
      question: string;
      /** Independent angles to pursue. Default 3. */
      angles?: number;
      /** Verifiers voting on each claim. Default 3, use an odd number. */
      voters?: number;
      /** Where to look. Default "web". */
      scope?: "web" | "codebase";
    };

interface Claim {
  claim: string;
  source: string;
}

interface Verdict {
  supported: boolean;
  reason: string;
}

const CLAIM_SCHEMA = {
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
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["supported", "reason"],
  properties: {
    supported: { type: "boolean" },
    reason: { type: "string" },
  },
};

/** Collapses claims that differ only in wording, so voting isn't spent twice. */
function dedupe(claims: Claim[]): Claim[] {
  const seen = new Map<string, Claim>();
  for (const claim of claims) {
    const key = claim.claim
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .sort()
      .join(" ");
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, claim);
    } else if (!existing.source.includes(claim.source)) {
      // Same claim from a second source is stronger, not redundant.
      existing.source += `; ${claim.source}`;
    }
  }
  return [...seen.values()];
}

export default async function deepResearch({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const question = typeof args === "string" ? args : args?.question;
  if (question === undefined || question === "") {
    return 'No question given. Pass --args \'{"question":"..."}\'.';
  }

  const config = typeof args === "string" ? undefined : args;
  const angleCount = config?.angles ?? 3;
  const voterCount = config?.voters ?? 3;
  const scope = config?.scope ?? "web";

  const how =
    scope === "web"
      ? "Search the web and read the primary sources you find. Cite a URL for every claim."
      : "Search this repository with grep, glob, and file reads. Cite a file path, with a line number where useful, for every claim.";

  // 1. Decompose. Angles that can contradict each other are worth more than
  //    angles that merely cover different ground.
  const plan = await phase("plan", () =>
    agentJSON<{ angles: string[] }>(
      `Break this research question into exactly ${angleCount} independent angles:\n\n` +
        `"${question}"\n\n` +
        `Each angle must be answerable on its own and must not overlap the others. ` +
        `Favor angles that could contradict each other, so disagreement surfaces ` +
        `instead of hiding. Keep each angle to one sentence.`,
      {
        type: "object",
        required: ["angles"],
        properties: { angles: { type: "array", items: { type: "string" } } },
      },
      { label: `decompose: ${question}`, readOnly: true }
    )
  );

  const angles = plan?.angles?.slice(0, angleCount) ?? [question];

  // 2. Gather sourced claims, one agent per angle.
  const gathered = await phase("gather", () =>
    pipeline(angles, (angle) =>
      agentJSON<{ claims: Claim[] }>(
        `Research this angle of the question "${question}":\n\n${angle}\n\n` +
          `${how}\n\n` +
          `Extract specific, checkable factual claims. A claim like "it is faster" ` +
          `is useless; "p50 latency dropped from 120ms to 45ms in v2.2" is checkable. ` +
          `Omit anything you could not source. Return at most 6 claims.`,
        CLAIM_SCHEMA,
        { label: angle, readOnly: true }
      )
    )
  );

  const claims = dedupe(gathered.flatMap((g) => g?.claims ?? []));
  if (claims.length === 0) {
    return `No sourced claims could be gathered for: ${question}`;
  }

  // 3. Vote. Verifiers see the claim and its source, never its author.
  const ballots = await phase("verify", () =>
    pipeline(claims, (claim) =>
      pipeline(Array.from({ length: voterCount }, (_, i) => i), (voter) =>
        agentJSON<Verdict>(
          `Independently check this claim:\n\n"${claim.claim}"\n\n` +
            `Cited source: ${claim.source}\n\n` +
            `${how}\n\n` +
            `Check it against the cited source and at least one other. Answer ` +
            `supported:false only if you find it contradicted or genuinely ` +
            `unsupported, not merely because you could not find corroboration. ` +
            `State in the reason what you actually checked.`,
          VERDICT_SCHEMA,
          {
            label: `vote ${voter + 1}: ${claim.claim}`,
            readOnly: true,
          }
        )
      )
    )
  );

  const verified: Claim[] = [];
  const refuted: Array<Claim & { why: string }> = [];
  const unverified: Claim[] = [];

  claims.forEach((claim, i) => {
    const cast = ballots[i].filter((v): v is Verdict => v !== null);
    if (cast.length === 0) {
      // Every verifier failed. That is unknown, not false.
      unverified.push(claim);
      return;
    }
    const support = cast.filter((v) => v.supported).length;
    if (support * 2 > cast.length) verified.push(claim);
    else {
      refuted.push({
        ...claim,
        why: cast.find((v) => !v.supported)?.reason ?? "no reason given",
      });
    }
  });

  if (verified.length === 0 && unverified.length === 0) {
    return (
      `Every claim gathered for "${question}" failed cross-checking.\n\n` +
      refuted.map((r) => `- ${r.claim}\n  refuted: ${r.why}`).join("\n")
    );
  }

  // 4. Synthesize from verified claims only.
  const report = await phase("synthesize", () =>
    agent(
      `Write a report answering: "${question}"\n\n` +
        `Use ONLY these cross-checked claims:\n${JSON.stringify(verified, null, 2)}\n\n` +
        (unverified.length > 0
          ? `These could not be checked. List them in a separate "Unverified" ` +
            `section at the end; never mix them into the findings:\n` +
            JSON.stringify(unverified, null, 2) +
            `\n\n`
          : "") +
        `Cite the source inline for every claim. Where sources disagree, say so ` +
        `rather than picking a side. Add nothing that is not in these claims. ` +
        `Lead with the direct answer to the question.`,
      { label: "cited report", readOnly: true }
    )
  );

  const audit = [
    `${angles.length} angles`,
    `${claims.length} distinct claims`,
    `${verified.length} verified`,
    `${refuted.length} dropped in cross-checking`,
    `${unverified.length} unverified`,
    `${voterCount} voters per claim`,
  ].join(" · ");

  return `${report ?? "Report generation failed."}\n\n---\n${audit}`;
}
