#!/usr/bin/env node

/**
 * Guards the worktree patch round-trip that `templates/migrate.ts` performs.
 *
 * A git diff is bytes, not text. Trimming it drops the newline that terminates
 * the final hunk and `git apply` then rejects the whole patch as corrupt;
 * decoding it as UTF-8 rewrites any byte that isn't valid UTF-8. Both failures
 * are silent at capture time and only surface when the patch is applied, by
 * which point the agent that produced it is gone. This builds a throwaway repo,
 * proves each corruption really does fail, proves the byte-exact path really
 * does apply, and greps the shipped scripts for the idiom.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const failures = [];
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** `git apply --check` against `repo`, as an exit code rather than a throw. */
function applyCheck(repo, bytes, scratch, label) {
  const file = path.join(scratch, `${label}.patch`);
  writeFileSync(file, bytes);
  try {
    git(repo, "apply", "--binary", "--whitespace=nowarn", "--check", file);
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.status ?? -1, stderr: String(error.stderr).trim().split("\n")[0] ?? "" };
  }
}

/**
 * The line a `corrupt patch` error names, or null if that isn't the error.
 * Git worded this `at line N` and later `at <file>:N`, so match the shape
 * rather than the sentence.
 */
function corruptPatchLine(stderr) {
  if (!/corrupt patch\b/.test(stderr)) return null;
  const line = /(\d+)\s*$/.exec(stderr);
  return line === null ? null : Number(line[1]);
}

function capturePatch(cwd) {
  git(cwd, "add", "-A");
  return execFileSync("git", ["diff", "--binary", "--cached", "HEAD"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function buildFixture(root) {
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  git(root, "init", "-q", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "patch-roundtrip-test");

  // A generated schema snapshot: the shape of patch that first hit this in
  // production, large enough that the corrupt line number is far from the end.
  const snapshot = JSON.stringify(
    { tables: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, { cols: ["id", "name"] }])) },
    null,
    2
  );
  writeFileSync(path.join(repo, "snapshot.json"), `${snapshot}\n`);
  writeFileSync(path.join(repo, "route.ts"), "export const route = 1;\n");
  writeFileSync(path.join(repo, "no-newline.txt"), "last line has no newline");
  writeFileSync(path.join(repo, "logo.bin"), randomBytes(4096));
  // Latin-1 bytes in a tracked file: valid on disk, not valid UTF-8.
  writeFileSync(path.join(repo, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  return { repo, worktree };
}

async function testRoundTrip(scratch) {
  const { repo, worktree } = buildFixture(scratch);

  // Every kind of edit a migration agent realistically makes.
  writeFileSync(path.join(worktree, "route.ts"), "export const route = 2;\n");
  writeFileSync(path.join(worktree, "no-newline.txt"), "still no trailing newline");
  writeFileSync(path.join(worktree, "logo.bin"), randomBytes(4096));
  writeFileSync(path.join(worktree, "created.ts"), "export const added = true;\n");
  const snapshot = JSON.parse(await fs.readFile(path.join(worktree, "snapshot.json"), "utf8"));
  snapshot.tables.t0.cols.push("migrated_at");
  writeFileSync(path.join(worktree, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  // A new generated migration snapshot, the shape that hit this in production:
  // every line of a large file lands in the patch as an insertion.
  await fs.mkdir(path.join(worktree, "migrations"), { recursive: true });
  writeFileSync(
    path.join(worktree, "migrations", "snapshot.json"),
    `${JSON.stringify(
      { tables: Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`t${i}`, { cols: ["id", "name", "created_at"] }])) },
      null,
      2
    )}\n`
  );

  const patch = capturePatch(worktree);
  const patchLines = patch.toString("utf8").split("\n").length;
  ok(patchLines > 5000, `large-patch case should be thousands of lines, got ${patchLines}`);
  ok(Buffer.isBuffer(patch), "capturePatch must return a Buffer, not a string");
  ok(patch.length > 0, "fixture produced an empty patch");
  ok(patch.at(-1) === 0x0a, "a git diff ends with a newline; the fixture is wrong if it does not");
  ok(
    patch.includes("GIT binary patch"),
    "fixture should exercise a real binary delta (needs --binary)"
  );
  ok(
    patch.includes("created.ts"),
    "a file the agent created must be in the patch; `git diff HEAD` alone omits untracked files"
  );

  const raw = applyCheck(repo, patch, scratch, "raw");
  ok(raw.code === 0, `raw patch bytes must apply cleanly, got rc ${raw.code} ${raw.stderr}`);

  const trimmed = applyCheck(repo, patch.toString("utf8").trim(), scratch, "trimmed");
  ok(
    trimmed.code !== 0,
    "a trimmed patch must be rejected; if git ever accepts one this test has stopped proving anything"
  );
  const corruptAt = corruptPatchLine(trimmed.stderr);
  ok(
    corruptAt !== null,
    `expected a "corrupt patch" error from the trimmed patch, got: ${trimmed.stderr || "(no stderr)"}`
  );
  // As in production: the reported line is deep in the patch, nowhere near the
  // capture that actually broke it, which is why this was misread as a conflict.
  ok(
    corruptAt === null || corruptAt > 1000,
    `expected the failure deep in a large patch, got line ${corruptAt}`
  );

  // Restoring only the trailing newline makes it apply again, so nothing else
  // about the trimmed patch can explain the rejection above.
  const restored = applyCheck(repo, `${patch.toString("utf8").trim()}\n`, scratch, "restored");
  ok(
    restored.code === 0,
    `restoring the trailing newline should make the patch applicable, got rc ${restored.code} ${restored.stderr}`
  );

  // The patch really does round-trip: apply it for real and compare bytes.
  git(repo, "apply", "--binary", "--whitespace=nowarn", path.join(scratch, "raw.patch"));
  for (const file of ["route.ts", "no-newline.txt", "logo.bin", "created.ts", "snapshot.json"]) {
    const applied = await fs.readFile(path.join(repo, file));
    const source = await fs.readFile(path.join(worktree, file));
    ok(applied.equals(source), `${file} differs after the round-trip`);
  }
}

async function testNonUtf8(scratch) {
  const { repo, worktree } = buildFixture(scratch);
  writeFileSync(path.join(worktree, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]));

  const patch = capturePatch(worktree);
  const decoded = Buffer.from(patch.toString("utf8"), "utf8");
  ok(
    !patch.equals(decoded),
    "fixture should contain bytes that a UTF-8 round-trip changes; otherwise it proves nothing"
  );
  ok(applyCheck(repo, patch, scratch, "latin1-raw").code === 0, "raw non-UTF-8 patch must apply");
  ok(
    applyCheck(repo, patch.toString("utf8"), scratch, "latin1-decoded").code !== 0,
    "a UTF-8-decoded patch must be rejected rather than silently applying mangled bytes"
  );
}

/**
 * The exact shape that made this bug so confusing to diagnose.
 *
 * A unified diff encodes a blank context line as a single space, so the last
 * line of this patch is `" "`. `.trim()` therefore removes three bytes —
 * `"\n"`, `" "`, `"\n"` — deleting a whole context line rather than just a line
 * terminator. The final hunk is then one line shorter than its header declares,
 * which is why git reports a corrupt patch pointing at the hunk instead of
 * complaining about a missing newline.
 */
async function testBlankContextTail(scratch) {
  const repo = path.join(scratch, "repo");
  const worktree = path.join(scratch, "worktree");
  git(scratch, "init", "-q", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "patch-roundtrip-test");

  // Four lines then a blank one: editing the second puts the blank line last in
  // the hunk's trailing context, where trimming can reach it.
  writeFileSync(path.join(repo, "handler.ts"), "one\ntwo\nthree\nfour\n\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "worktree", "add", "--detach", "-q", worktree, "HEAD");

  writeFileSync(path.join(worktree, "handler.ts"), "one\nTWO\nthree\nfour\n\n");
  const raw = capturePatch(worktree);

  const lines = raw.toString("utf8").split("\n");
  ok(
    lines.at(-2) === " ",
    `the fixture must end in a blank context line, got ${JSON.stringify(lines.at(-2))}`
  );

  const trimmed = Buffer.from(raw.toString("utf8").trim(), "utf8");
  ok(
    raw.length - trimmed.length === 3,
    `trimming must eat the blank context line (3 bytes), lost ${raw.length - trimmed.length}`
  );

  const rawResult = applyCheck(repo, raw, scratch, "tail-raw");
  ok(rawResult.code === 0, `raw patch must apply, got rc ${rawResult.code} ${rawResult.stderr}`);

  const trimmedResult = applyCheck(repo, trimmed, scratch, "tail-trimmed");
  ok(trimmedResult.code === 128, `trimmed patch must fail with rc 128, got ${trimmedResult.code}`);
  ok(
    corruptPatchLine(trimmedResult.stderr) !== null,
    `trimming must produce a corrupt-patch error, got: ${trimmedResult.stderr}`
  );
}

const PATCH_SAFE_DIFF_FLAGS = ["--name-only", "--name-status", "--numstat", "--shortstat", "--stat"];

/**
 * Statement-level grep over the scripts we ship, so a future edit cannot
 * reintroduce the idiom without this failing.
 */
async function testShippedScripts() {
  const roots = [
    path.join(repoRoot, "plugins", "dynamic-workflows", "skills", "authoring-workflows", "templates"),
    path.join(repoRoot, "plugins", "dynamic-workflows", "workflows"),
  ];

  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = path.join(root, entry.name);
      const relative = path.relative(repoRoot, file);
      const source = await fs.readFile(file, "utf8");

      for (const statement of source.split(";")) {
        if (!/\bexecFileSync\b/.test(statement)) continue;

        if (/"diff"/.test(statement) && !PATCH_SAFE_DIFF_FLAGS.some((f) => statement.includes(f))) {
          ok(
            !/encoding\s*:/.test(statement),
            `${relative}: a git diff that produces a patch must not be decoded to a string`
          );
          ok(
            !/\.trim\(\)/.test(statement),
            `${relative}: never .trim() a git diff — it strips the newline git apply requires`
          );
        }

        if (/"apply"/.test(statement)) {
          ok(
            statement.includes("--binary"),
            `${relative}: git apply must pass --binary or a binary delta is rejected`
          );
          ok(
            !/"-"/.test(statement) && !/\binput\s*:/.test(statement),
            `${relative}: apply patches from a file, not re-encoded onto stdin`
          );
        }
      }
    }
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), "wf-patch-test-"));
try {
  for (const [name, run] of [
    ["roundtrip", testRoundTrip],
    ["nonutf8", testNonUtf8],
    ["blank-context-tail", testBlankContextTail],
  ]) {
    const dir = path.join(scratch, name);
    await fs.mkdir(dir);
    await run(dir);
  }
  await testShippedScripts();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Patch round-trip test failed (${failures.length} of ${checks} checks):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Patch round-trip test passed (${checks} checks).`);
