/**
 * Credential discovery.
 *
 * Requiring an exported `CURSOR_API_KEY` is poor ergonomics: the shell a person
 * exports it in is not the shell an agent runs commands in, so the export is
 * invisible where it matters. This resolves a key from several durable places
 * instead, and can also defer entirely to the SDK's own stored login.
 *
 * Precedence, highest first:
 *   1. CURSOR_API_KEY already in the environment
 *   2. ~/.cursor/workflows-runtime/.env        (private, never in a repo)
 *   3. <project>/.env.local, then <project>/.env
 *   4. the SDK login stored at ~/.cursor/sdk/auth.json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ROOT } from "./paths.js";

export type AuthSource =
  | "environment"
  | "runtime-env-file"
  | "project-env-file"
  | "stored-login"
  | "none";

export interface AuthResolution {
  /**
   * Pass to the SDK, or omit when undefined. Undefined with a `stored-login`
   * source is deliberate: the SDK resolves that itself, and passing an
   * explicit value would short-circuit its own resolution.
   */
  apiKey: string | undefined;
  source: AuthSource;
  /** Where it came from, for diagnostics. Never contains the key. */
  detail: string;
}

export function sdkAuthPath(): string {
  return join(homedir(), ".cursor", "sdk", "auth.json");
}

export function runtimeEnvPath(): string {
  return join(ROOT, ".env");
}

/** Minimal KEY=VALUE parser. No interpolation, no export keyword gymnastics. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

/** True when the stored SDK login exists and hasn't expired. */
function hasStoredLogin(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(sdkAuthPath(), "utf8")) as {
      apiKey?: unknown;
      apiKeyExpiresAtMs?: unknown;
    };
    if (typeof parsed.apiKey !== "string" || parsed.apiKey === "") return false;
    if (
      typeof parsed.apiKeyExpiresAtMs === "number" &&
      parsed.apiKeyExpiresAtMs <= Date.now()
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveAuth(cwd: string): AuthResolution {
  const fromEnv = process.env.CURSOR_API_KEY;
  if (fromEnv !== undefined && fromEnv !== "") {
    return {
      apiKey: fromEnv,
      source: "environment",
      detail: "CURSOR_API_KEY in the environment",
    };
  }

  const runtimeEnv = runtimeEnvPath();
  const fromRuntimeFile = parseEnvFile(runtimeEnv).CURSOR_API_KEY;
  if (fromRuntimeFile !== undefined && fromRuntimeFile !== "") {
    return {
      apiKey: fromRuntimeFile,
      source: "runtime-env-file",
      detail: runtimeEnv,
    };
  }

  for (const name of [".env.local", ".env"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const value = parseEnvFile(path).CURSOR_API_KEY;
    if (value !== undefined && value !== "") {
      return { apiKey: value, source: "project-env-file", detail: path };
    }
  }

  if (hasStoredLogin()) {
    // Deliberately no apiKey: the SDK reads this file itself, and an explicit
    // value would bypass its expiry and backend-pairing checks.
    return {
      apiKey: undefined,
      source: "stored-login",
      detail: sdkAuthPath(),
    };
  }

  return { apiKey: undefined, source: "none", detail: "no credential found" };
}

export function authHelpText(): string {
  return [
    "No Cursor credential found. Any one of these fixes it:",
    "",
    "  1. Sign in once (recommended, no env vars anywhere):",
    "       wf login",
    "",
    "  2. Store a key for the runtime only, outside any repo:",
    `       mkdir -p ${ROOT} && printf 'CURSOR_API_KEY=crsr_...\\n' > ${runtimeEnvPath()}`,
    `       chmod 600 ${runtimeEnvPath()}`,
    "",
    "  3. Put CURSOR_API_KEY in the project's .env.local",
    "     (only if that file is gitignored)",
    "",
    "  4. export CURSOR_API_KEY=crsr_... in the shell you launch from",
    "     (note: an export in your terminal is not visible to an agent's shell)",
    "",
    "Mint a key at https://cursor.com/dashboard/integrations",
  ].join("\n");
}
