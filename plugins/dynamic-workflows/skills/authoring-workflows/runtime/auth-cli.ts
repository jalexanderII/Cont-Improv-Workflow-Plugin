/**
 * Credential commands.
 *
 *   wf status   show which credential would be used, and from where
 *   wf login    browser sign-in; persists to ~/.cursor/sdk/auth.json
 *   wf logout   clear that stored login
 *
 * Signing in once beats exporting a key per shell: the stored login is
 * durable, works from any terminal or agent process, and never lands in a
 * repo or a shell history.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { authHelpText, resolveAuth, sdkAuthPath } from "./auth.js";
import { DEPS_DIR } from "./paths.js";

interface CursorAuth {
  login: (options?: { apiKeyTtlMs?: number }) => Promise<unknown>;
  logout: () => Promise<void>;
  status: () => Promise<{ loggedIn?: boolean; expiresAtMs?: number }>;
}

async function loadCursor(): Promise<{ auth: CursorAuth }> {
  const require = createRequire(resolve(DEPS_DIR, "package.json"));
  const entry = require.resolve("@cursor/sdk");
  const sdk = (await import(pathToFileURL(entry).href)) as {
    Cursor: { auth: CursorAuth };
  };
  return sdk.Cursor;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";

  if (command === "status") {
    const auth = resolveAuth(process.cwd());
    if (auth.source === "none") {
      process.stdout.write(authHelpText() + "\n");
      process.exit(1);
    }
    process.stdout.write(`Credential source: ${auth.source}\n`);
    process.stdout.write(`Location:          ${auth.detail}\n`);
    if (auth.source === "stored-login") {
      process.stdout.write(
        "Resolved by the SDK at run time, so no key is passed or logged.\n"
      );
    } else if (auth.source === "environment") {
      process.stdout.write(
        "Note: an environment variable only exists in the shell that exported it.\n" +
          "Agent-launched runs use a different shell. `wf login` avoids that.\n"
      );
    }
    return;
  }

  if (command === "login") {
    const cursor = await loadCursor();
    process.stdout.write("Opening the browser to sign in...\n");
    await cursor.auth.login();
    process.stdout.write(`Signed in. Stored at ${sdkAuthPath()}\n`);
    process.stdout.write("Workflows will now authenticate without any env vars.\n");
    return;
  }

  if (command === "logout") {
    const cursor = await loadCursor();
    await cursor.auth.logout();
    process.stdout.write("Signed out; stored login cleared.\n");
    return;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  process.stderr.write("usage: auth-cli.ts {status|login|logout}\n");
  process.exit(64);
}

void main();
