import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_HINTS } from "./constants.js";
import { runLinters, toHints } from "./linters.js";

const finding = (file: string, line: number) => ({
  RuleID: "aws-access-token",
  Description: "AWS key",
  StartLine: line,
  File: file,
});

test("toHints keeps only lines the PR adds, with paths relative to the repo", () => {
  const added = new Set(["src/a.ts:2"]);
  assert.deepEqual(toHints([finding("/repo/src/a.ts", 2), finding("/repo/src/a.ts", 1)], "/repo", added), [
    { path: "src/a.ts", line: 2, source: "gitleaks", rule: "aws-access-token", message: "AWS key" },
  ]);
});

test("toHints caps at MAX_HINTS and tolerates an empty report", () => {
  const many = Array.from({ length: MAX_HINTS + 5 }, (_, i) => finding("/repo/a.ts", i + 1));
  const added = new Set(many.map((f) => `a.ts:${f.StartLine}`));
  assert.equal(toHints(many, "/repo", added).length, MAX_HINTS);
  assert.deepEqual(toHints(null, "/repo", added), []);
  assert.deepEqual(toHints([], "/repo", added), []);
});

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let repo: string;
before(async () => {
  repo = await mkdtemp(join(tmpdir(), "otter-linters-"));
  mkdirSync(join(repo, "src"));
  // Fake keys: line 1 predates the PR (context), line 2 is added by it.
  writeFileSync(join(repo, "src", "a.ts"), 'const old = "AKIAZ7QWERTYUIOPASDF";\nconst key = "AKIAZ7ZXCVBNMQWERTYU";\n');
});
after(() => rm(repo, { recursive: true, force: true }));

const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n const old = 1;\n+const key = 1;\n";

test("runLinters: gitleaks reports only the secret the PR adds, redacted", { skip: hasGitleaks ? false : "gitleaks not installed (runs in the reviewer image)" }, async () => {
  const hints = await runLinters(repo, DIFF);
  assert.deepEqual(hints.map((h) => [h.path, h.line, h.rule]), [["src/a.ts", 2, "aws-access-token"]]);
  assert.doesNotMatch(JSON.stringify(hints), /AKIA/);
});

test("runLinters never throws: a missing directory just means no hints", async () => {
  assert.deepEqual(await runLinters(join(repo, "missing"), DIFF), []);
});
