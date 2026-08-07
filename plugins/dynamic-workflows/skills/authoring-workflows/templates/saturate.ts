/**
 * Shape: keep searching in rounds until the results stop growing.
 *
 * Use when you don't know how much there is to find: flaky tests, dead code,
 * undocumented endpoints. Each round is told what has already been found so it
 * looks somewhere new, and the loop ends when consecutive rounds add nothing.
 */

import type { WorkflowContext, WorkflowMeta } from "./_runtime.js";

export const meta: WorkflowMeta = {
  name: "saturate",
  description: "Search in rounds until consecutive rounds stop finding anything new",
  size: "medium",
};

interface Args {
  /** What to look for, e.g. "flaky tests in this repo". */
  goal: string;
  /** Parallel searchers per round. */
  width?: number;
  /** Stop after this many consecutive rounds with no new items. */
  quietRounds?: number;
  /** Hard ceiling on rounds. */
  maxRounds?: number;
}

export default async function saturate({
  agent,
  agentJSON,
  pipeline,
  phase,
  args,
}: WorkflowContext<Args>): Promise<string> {
  const { goal, width = 4, quietRounds = 2, maxRounds = 6 } = args;

  const found = new Map<string, string>();
  let quiet = 0;
  let round = 0;

  while (round < maxRounds && quiet < quietRounds) {
    round += 1;
    const known = [...found.keys()];

    const newThisRound = await phase(`round ${round}`, async () => {
      const batches = await pipeline(
        Array.from({ length: width }, (_, i) => i),
        (searcher) =>
          agentJSON<{ items: Array<{ id: string; detail: string }> }>(
            `Search for: ${goal}\n\n` +
              (known.length > 0
                ? `Already found, do not report these again:\n${known.join("\n")}\n\n` +
                  `Look somewhere the earlier passes did not.\n\n`
                : "") +
              `You are searcher ${searcher + 1} of ${width} working in parallel; ` +
              `pick a distinct area to cover. Give each item a short stable id and ` +
              `enough detail to act on. Report nothing if you find nothing new.`,
            {
              type: "object",
              required: ["items"],
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["id", "detail"],
                    properties: {
                      id: { type: "string" },
                      detail: { type: "string" },
                    },
                  },
                },
              },
            },
            { label: `round ${round} searcher ${searcher + 1}`, readOnly: true }
          )
      );

      let added = 0;
      for (const batch of batches) {
        for (const item of batch?.items ?? []) {
          if (!found.has(item.id)) {
            found.set(item.id, item.detail);
            added += 1;
          }
        }
      }
      return added;
    });

    quiet = newThisRound === 0 ? quiet + 1 : 0;
  }

  if (found.size === 0) return `Nothing found for: ${goal} (${round} rounds).`;

  const report = await phase("synthesize", () =>
    agent(
      `Organize these findings for "${goal}" into a report:\n\n` +
        JSON.stringify([...found.entries()], null, 2) +
        `\n\nGroup related items, rank by importance, and note any patterns across them. ` +
        `Do not add items that are not in this list.`,
      { label: "final report", readOnly: true }
    )
  );

  const reason =
    quiet >= quietRounds
      ? `saturated after ${quiet} quiet rounds`
      : `hit the ${maxRounds}-round ceiling, so more may remain`;

  return `${report ?? "Report generation failed."}\n\n---\n${found.size} items over ${round} rounds (${reason}).`;
}
