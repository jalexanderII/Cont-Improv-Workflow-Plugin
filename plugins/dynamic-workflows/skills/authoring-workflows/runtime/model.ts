/**
 * Model selection: a catalog id plus optional parameters.
 *
 * In `@cursor/sdk`, effort and speed are **parameters**, not part of the model
 * id. `grok-4.5` with `effort=high, fast=true` is a valid selection;
 * `cursor-grok-4.5-high-fast` is not a model and the backend rejects it.
 *
 * Everything here is pure and SDK-free so flag parsing needs no network and no
 * dependency on the installed SDK. Invalid id/parameter combinations are the
 * backend's to reject at agent start, where the existing error path already
 * records the failure and lets the rest of the fan-out continue.
 */

import type { ModelParameterValue, ModelSelection } from "./public-types.js";

/**
 * Parses one `--param id=value` flag.
 *
 * Throws rather than returning a sentinel so the caller decides the exit code;
 * `run.ts` turns this into a usage error.
 */
export function parseModelParam(flag: string): ModelParameterValue {
  const separator = flag.indexOf("=");
  if (separator === -1) {
    throw new Error(`expected id=value, got "${flag}"`);
  }
  const id = flag.slice(0, separator).trim();
  const value = flag.slice(separator + 1).trim();
  if (id === "" || value === "") {
    throw new Error(`expected id=value with both sides non-empty, got "${flag}"`);
  }
  return { id, value };
}

/** Parses `effort=high,fast=true`, the env-var form of repeated `--param`. */
export function parseModelParamList(raw: string): ModelParameterValue[] {
  let params: ModelParameterValue[] = [];
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") continue;
    params = upsertModelParam(params, parseModelParam(entry));
  }
  return params;
}

/**
 * Adds a parameter, replacing any earlier one with the same id, so a later
 * `--param effort=low` wins over an earlier `--param effort=high` instead of
 * both reaching the SDK.
 */
export function upsertModelParam(
  params: readonly ModelParameterValue[],
  next: ModelParameterValue
): ModelParameterValue[] {
  return [...params.filter((p) => p.id !== next.id), next];
}

/**
 * Canonical form for hashing, comparison, and the wire.
 *
 * Sorting by id means `--param effort=high --param fast=true` and the reverse
 * order produce the same cache key. An empty list drops the `params` key
 * entirely, which is how the SDK is told to apply the model's own default
 * variant — the runtime never invents a default client-side.
 */
export function normalizeModelSelection(selection: ModelSelection): ModelSelection {
  const params = (selection.params ?? [])
    .map((p) => ({ id: p.id, value: p.value }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return params.length === 0
    ? { id: selection.id }
    : { id: selection.id, params };
}

/**
 * Resolves the selection for one agent against the run-level default.
 *
 * Parameters come from the first of: the object form's `params`, the separate
 * `modelParams` option, then the run's own parameters — but only when the agent
 * kept the run's model id. Carrying `effort=high` from one model onto a
 * different one the script deliberately picked would silently change a
 * selection the author never asked for, and can be invalid outright since each
 * model declares its own parameters.
 */
export function resolveModelSelection(
  options: {
    model?: string | ModelSelection;
    modelParams?: ModelParameterValue[];
  },
  runDefault: ModelSelection
): ModelSelection {
  const override = options.model;
  const overrideParams = typeof override === "object" ? override.params : undefined;
  const id = typeof override === "string" ? override : override?.id ?? runDefault.id;

  const params =
    overrideParams ??
    options.modelParams ??
    (id === runDefault.id ? runDefault.params : undefined);

  return normalizeModelSelection({ id, params });
}

/**
 * One-line form for the progress views, which render this field verbatim:
 * `grok-4.5 (effort=high, fast=true)`.
 */
export function formatModelSelection(selection: ModelSelection): string {
  if (selection.params === undefined || selection.params.length === 0) {
    return selection.id;
  }
  const params = selection.params.map((p) => `${p.id}=${p.value}`).join(", ");
  return `${selection.id} (${params})`;
}
