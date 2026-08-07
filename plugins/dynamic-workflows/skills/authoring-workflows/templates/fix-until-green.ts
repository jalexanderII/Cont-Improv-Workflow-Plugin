/**
 * Shape: run a checker, fix what failed, repeat until it passes or stalls.
 *
 * The stall detector matters more than the round cap: a loop that stops making
 * progress will happily burn every remaining round otherwise.
 */

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "fix-until-green",
  description: "Run a check, fix the failures, repeat until it passes or stalls",
  size: "medium",
};

interface Args {
  /** Command to run, e.g. "npx tsc --noEmit". */
  check: string;
  /** Give up after this many rounds. */
  maxRounds?: number;
  /** Stop after this many consecutive rounds without progress. */
  stallRounds?: number;
}

interface CheckResult {
  passed: boolean;
  failureCount: number;
  failures: string[];
}

export default async function fixUntilGreen({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const { check, maxRounds = 5, stallRounds = 2 } = args;
  const history: number[] = [];

  const runCheck = (round: number) =>
    agentJSON<CheckResult>(
      `Run \`${check}\` and report the result.\n\n` +
        `List each distinct failure as one entry with enough detail to fix it ` +
        `(file, line, message). Do not fix anything yet.`,
      {
        type: "object",
        required: ["passed", "failureCount", "failures"],
        properties: {
          passed: { type: "boolean" },
          failureCount: { type: "number" },
          failures: { type: "array", items: { type: "string" } },
        },
      },
      { label: `check round ${round}`, phase: `round ${round}` }
    );

  for (let round = 1; round <= maxRounds; round += 1) {
    const result = await phase(`round ${round}`, async () => {
      const current = await runCheck(round);
      if (current === null) return { stop: true, message: "Check agent failed." };
      if (current.passed) {
        return { stop: true, message: `\`${check}\` passed on round ${round}.` };
      }

      history.push(current.failureCount);
      const recent = history.slice(-(stallRounds + 1));
      if (
        recent.length > stallRounds &&
        new Set(recent).size === 1
      ) {
        return {
          stop: true,
          message:
            `Stalled at ${current.failureCount} failures for ${stallRounds + 1} ` +
            `consecutive rounds. Remaining failures:\n` +
            current.failures.slice(0, 20).join("\n"),
        };
      }

      // One agent per failure. Fewer, larger agents conflict on the same files.
      await pipeline(current.failures, (failure) =>
        agent(
          `Fix this failure reported by \`${check}\`:\n\n${failure}\n\n` +
            `Make the smallest change that fixes it. Do not suppress the error, ` +
            `do not disable the check, and do not touch unrelated code.`,
          { label: failure.slice(0, 70) }
        )
      );
      return { stop: false, message: "" };
    });

    if (result.stop) return result.message;
  }

  const final = await runCheck(maxRounds + 1);
  return final?.passed === true
    ? `\`${check}\` passed after ${maxRounds} rounds.`
    : `Gave up after ${maxRounds} rounds with ${final?.failureCount ?? "unknown"} ` +
        `failures remaining:\n${(final?.failures ?? []).slice(0, 20).join("\n")}`;
}
