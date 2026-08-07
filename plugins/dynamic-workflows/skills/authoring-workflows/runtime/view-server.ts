/**
 * Live HTTP progress view.
 *
 * A canvas can't do this: canvases embed their data inline and are forbidden
 * from making network calls, so they can't poll a run in flight. This server
 * is the pull-based option, and the one that scales to hundreds of agents.
 */

import { createServer, type Server } from "node:http";

import type { RunStore } from "./state.js";
import type { RunState } from "./types.js";
import { PAGE } from "./view-page.js";

/**
 * Only what the page renders. The full snapshot carries a result preview and a
 * content hash per agent, which the page never shows — at several hundred
 * agents that is a large payload serialized and sent every second, for nothing.
 */
function projectForView(state: RunState): unknown {
  return {
    runId: state.runId,
    workflow: state.workflow,
    status: state.status,
    cwd: state.cwd,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    concurrency: state.concurrency,
    totals: state.totals,
    agents: state.agents.map((a) => ({
      id: a.id,
      label: a.label,
      phase: a.phase,
      status: a.status,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      tokens: a.tokens,
      error: a.error,
    })),
  };
}

export interface ServerHandle {
  url: string;
  close: () => void;
}

export async function startViewServer(
  store: RunStore,
  port = 0
): Promise<ServerHandle> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/state") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(projectForView(store.snapshot)));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // A requested port being taken must not sink the run: fall back to an
      // ephemeral one and report the URL that actually bound.
      if (err.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, "127.0.0.1", resolve);
        return;
      }
      reject(err);
    });
    // Loopback only. Run state can contain repo paths and prompt text.
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const resolved =
    typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://127.0.0.1:${resolved}`,
    close: () => server.close(),
  };
}
