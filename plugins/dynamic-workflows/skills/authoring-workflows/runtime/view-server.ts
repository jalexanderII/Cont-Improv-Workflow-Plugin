/**
 * Live HTTP progress view.
 *
 * A canvas can't do this: canvases embed their data inline and are forbidden
 * from making network calls, so they can't poll a run in flight. This server
 * is the pull-based option, and the one that scales to hundreds of agents.
 */

import { createServer, type Server, type ServerResponse } from "node:http";

import type { RunStore } from "./state.js";
import { loadTranscript, readLiveTranscript } from "./transcript.js";
import type { RunState } from "./types.js";
import { PAGE } from "./view-page.js";
import {
  renderTranscriptError,
  renderTranscriptPage,
  type TranscriptPageData,
} from "./view-transcript.js";

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
      // Only whether a transcript can be opened, not the id itself: the page
      // asks for it by agent number and the server resolves it. A running agent
      // is readable from the live buffer before it has a stored transcript.
      transcript: a.runId !== undefined || a.status === "running",
      transcriptPruned: a.transcriptPruned === true,
    })),
  };
}

export interface ServerHandle {
  url: string;
  close: () => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * Resolves an agent's transcript against the live run, so a URL only ever
 * names an agent number in this run and never an SDK run id.
 */
async function readTranscript(
  store: RunStore,
  agentNumber: number
): Promise<
  | { ok: true; page: TranscriptPageData }
  | { ok: false; status: number; error: string }
> {
  const state = store.snapshot;
  const record = state.agents.find((a) => a.id === agentNumber);
  if (record === undefined) {
    return { ok: false, status: 404, error: `No agent #${agentNumber} in this run.` };
  }

  // A running agent is served from the live buffer, never from the store: the
  // store's conversation() tails the run's event stream and would not resolve
  // until this agent finished, turning a page load into a hang.
  if (record.status === "pending" || record.status === "running") {
    const live = readLiveTranscript(agentNumber);
    if (live === undefined) {
      return {
        ok: false,
        status: 404,
        error: "This agent hasn't produced any output yet. Reload in a moment.",
      };
    }
    return {
      ok: true,
      page: {
        ...live,
        label: record.label,
        phase: record.phase,
        workflow: state.workflow,
        agentNumber,
        backHref: "/",
      },
    };
  }

  if (record.runId === undefined) {
    return {
      ok: false,
      status: 404,
      error:
        record.transcriptPruned === true
          ? "This transcript expired and was removed by retention."
          : "This agent has no transcript. An agent that never started, or a dry run, does not produce one.",
    };
  }

  try {
    const transcript = await loadTranscript(record.runId, record.cwd ?? state.cwd);
    return {
      ok: true,
      page: {
        ...transcript,
        label: record.label,
        phase: record.phase,
        workflow: state.workflow,
        agentNumber,
        backHref: "/",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The dashboard holds the snapshot it started with, so a `wf prune` during
    // the post-run linger leaves it linking to a transcript that is now gone.
    return {
      ok: false,
      status: 502,
      error: /not found/i.test(message)
        ? "This transcript is no longer in the agent store. It was most likely removed by `wf prune`."
        : message,
    };
  }
}


export async function startViewServer(
  store: RunStore,
  port = 0
): Promise<ServerHandle> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/state") {
      sendJson(res, 200, projectForView(store.snapshot));
      return;
    }

    // `/agent/3` is the page a View link opens; `.json` is the same data for
    // anything scripting against a live run.
    const agent = /^\/agent\/(\d+)(\.json)?$/.exec(req.url ?? "");
    if (agent !== null) {
      const number = Number(agent[1]);
      const asJson = agent[2] !== undefined;
      void readTranscript(store, number).then((result) => {
        if (result.ok) {
          if (asJson) sendJson(res, 200, result.page);
          else sendHtml(res, 200, renderTranscriptPage(result.page));
          return;
        }
        if (asJson) sendJson(res, result.status, { error: result.error });
        else sendHtml(res, result.status, renderTranscriptError(number, result.error));
      });
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
