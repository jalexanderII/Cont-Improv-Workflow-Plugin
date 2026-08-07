/**
 * Final-report canvas emitter.
 *
 * Canvases embed their data inline and cannot make network calls, so this runs
 * once the workflow finishes and bakes the completed run into a single
 * `.canvas.tsx`. That constraint is also the strength: the result is a
 * self-contained artifact of what the run found.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canvasDirFor } from "./paths.js";
import type { RunState } from "./types.js";

function slug(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Everything the canvas component reads, serialized as one inline literal. */
function buildData(state: RunState, report: unknown) {
  const byPhase = new Map<string, typeof state.agents>();
  for (const a of state.agents) {
    const list = byPhase.get(a.phase) ?? [];
    list.push(a);
    byPhase.set(a.phase, list);
  }

  return {
    workflow: state.workflow,
    runId: state.runId,
    status: state.status,
    cwd: state.cwd,
    startedAt: state.startedAt,
    durationMs: (state.endedAt ?? Date.now()) - state.startedAt,
    totals: state.totals,
    report:
      typeof report === "string" ? report : JSON.stringify(report, null, 2),
    failures: state.agents
      .filter((a) => a.status === "error" || a.status === "cancelled")
      .map((a) => ({ id: a.id, label: a.label, error: a.error ?? "unknown" })),
    phases: [...byPhase.entries()].map(([name, agents]) => ({
      name,
      tokens: agents.reduce((n, a) => n + a.tokens, 0),
      agents: agents.map((a) => ({
        id: a.id,
        label: a.label,
        status: a.status,
        seconds:
          a.startedAt === undefined
            ? 0
            : Math.round(((a.endedAt ?? Date.now()) - a.startedAt) / 1000),
        tokens: a.tokens,
      })),
    })),
  };
}

/**
 * Declared explicitly rather than inferred: `as const` on the data literal
 * turns empty arrays into `never[]` and counts into literal types, which
 * breaks `.map()` and length comparisons on runs that happen to have no
 * failures or exactly one phase.
 */
const DATA_TYPES = String.raw`
interface AgentRow {
  id: number;
  label: string;
  status: string;
  seconds: number;
  tokens: number;
}

interface PhaseGroup {
  name: string;
  tokens: number;
  agents: AgentRow[];
}

interface Failure {
  id: number;
  label: string;
  error: string;
}

interface ReportData {
  workflow: string;
  runId: string;
  status: string;
  cwd: string;
  startedAt: number;
  durationMs: number;
  totals: {
    agents: number;
    running: number;
    finished: number;
    cached: number;
    errored: number;
    tokens: number;
  };
  report: string;
  failures: Failure[];
  phases: PhaseGroup[];
}
`;

const COMPONENT = String.raw`
type Tone = "success" | "danger" | "warning" | "info" | "neutral";

const TONE_BY_STATUS: Record<string, Tone> = {
  finished: "success",
  cached: "info",
  running: "warning",
  error: "danger",
  cancelled: "danger",
  pending: "neutral",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

export default function WorkflowRunReport() {
  const startedAt = new Date(DATA.startedAt).toLocaleString();

  return (
    <Stack gap={20} style={{ padding: 24 }}>
      <Stack gap={4}>
        <H1>{DATA.workflow}</H1>
        <Text tone="tertiary" size="small">
          {DATA.runId} · {DATA.status} · started {startedAt} · {DATA.cwd}
        </Text>
      </Stack>

      <Grid columns={5} gap={16}>
        <Stat value={DATA.totals.agents} label="Agents" />
        <Stat value={DATA.totals.finished} label="Completed" tone="success" />
        <Stat value={DATA.totals.cached} label="From cache" tone="info" />
        <Stat
          value={DATA.totals.errored}
          label="Failed"
          tone={DATA.totals.errored > 0 ? "danger" : undefined}
        />
        <Stat value={formatTokens(DATA.totals.tokens)} label="Tokens" />
      </Grid>

      <Card>
        <CardHeader trailing={<Pill size="sm">{formatDuration(DATA.durationMs)}</Pill>}>
          Report
        </CardHeader>
        <CardBody>
          <Text style={{ whiteSpace: "pre-wrap" }}>{DATA.report}</Text>
        </CardBody>
      </Card>

      {DATA.failures.length > 0 && (
        <Callout tone="danger" title={DATA.failures.length + " agents failed"}>
          <Stack gap={4}>
            {DATA.failures.map((f) => (
              // These primitives declare exact prop types with no key, so the
              // React key goes on a plain wrapper element.
              <div key={f.id}>
                <Text size="small">
                  #{f.id} {f.label} — {f.error}
                </Text>
              </div>
            ))}
          </Stack>
        </Callout>
      )}

      <Stack gap={12}>
        <H2>Agents by phase</H2>
        <Text tone="tertiary" size="small">
          Source: workflow run {DATA.runId} · time and tokens are per agent
        </Text>
        {DATA.phases.map((phase) => (
          <div key={phase.name}>
            <CollapsibleSection
              title={phase.name}
              count={phase.agents.length}
              trailing={formatTokens(phase.tokens) + " tokens"}
              defaultOpen={DATA.phases.length === 1}
            >
              <Table
                headers={["#", "Agent", "Status", "Time (s)", "Tokens"]}
                columnAlign={["right", "left", "left", "right", "right"]}
                rowTone={phase.agents.map((a) => TONE_BY_STATUS[a.status])}
                rows={phase.agents.map((a) => [
                  a.id,
                  a.label,
                  a.status,
                  a.seconds,
                  formatTokens(a.tokens),
                ])}
                striped
                stickyHeader
              />
            </CollapsibleSection>
          </div>
        ))}
      </Stack>

      <Text tone="quaternary" size="small">
        Generated by the dynamic-workflows runtime
      </Text>
    </Stack>
  );
}
`;

export function emitCanvas(
  state: RunState,
  report: unknown,
  workspacePath: string
): string {
  const dir = canvasDirFor(workspacePath);
  mkdirSync(dir, { recursive: true });

  const file = `workflow-${slug(state.workflow)}-${state.runId}.canvas.tsx`;
  const path = join(dir, file);

  const source = [
    "// Generated by the dynamic-workflows runtime. Regenerated on each run.",
    'import {',
    "  Callout,",
    "  Card,",
    "  CardBody,",
    "  CardHeader,",
    "  CollapsibleSection,",
    "  Grid,",
    "  H1,",
    "  H2,",
    "  Pill,",
    "  Stack,",
    "  Stat,",
    "  Table,",
    "  Text,",
    '} from "cursor/canvas";',
    DATA_TYPES,
    "const DATA: ReportData = " +
      JSON.stringify(buildData(state, report), null, 2) +
      ";",
    COMPONENT,
  ].join("\n");

  writeFileSync(path, source);
  return path;
}
