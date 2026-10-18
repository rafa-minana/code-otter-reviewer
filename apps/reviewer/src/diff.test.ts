import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDiff, parseDiff } from "./diff.js";

const fileDiff = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

const AUTH = fileDiff(
  "src/auth.ts",
  "@@ -10,4 +40,4 @@ function login\n   const user = await find(email);\n-  return check(user);\n+  if (!user) return null;\n+  return check(user, pass);\n",
);
const DELETED =
  "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 1..0\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
const BINARY =
  "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
const LOCK = fileDiff("package-lock.json", "@@ -1 +1 @@\n-a\n+b\n");
const opts = { maxTokens: 10_000, maxCalls: 3, ignore: [] };

test("renders PR-Agent format, numbering only the new side", () => {
  const { chunks } = chunkDiff(AUTH, opts);
  assert.equal(
    chunks[0].text,
    [
      "## File: 'src/auth.ts'",
      "",
      "@@ -10,4 +40,4 @@ function login",
      "__new hunk__",
      "40    const user = await find(email);",
      "41 +  if (!user) return null;",
      "42 +  return check(user, pass);",
      "__old hunk__",
      "   const user = await find(email);",
      "-  return check(user);",
    ].join("\n"),
  );
  assert.deepEqual(chunks[0].paths, ["src/auth.ts"]);
});

test("omits __old hunk__ when nothing was removed", () => {
  const { chunks } = chunkDiff(
    fileDiff("a.ts", "@@ -1 +1,2 @@\n x\n+y\n"),
    opts,
  );
  assert.ok(!chunks[0].text.includes("__old hunk__"));
});

test("filters binaries, default globs and .otter.yaml globs; lists deleted files by name", () => {
  const diff = [
    AUTH,
    DELETED,
    BINARY,
    LOCK,
    fileDiff("gen/api.ts", "@@ -1 +1 @@\n-a\n+b\n"),
  ].join("");
  const r = chunkDiff(diff, { ...opts, ignore: ["gen/**"] });
  assert.deepEqual(r.filtered, ["logo.png", "package-lock.json", "gen/api.ts"]);
  assert.deepEqual(r.deleted, ["old.ts"]);
  assert.deepEqual(
    r.chunks.map((c) => c.paths),
    [["src/auth.ts"]],
  );
  assert.deepEqual(r.notReviewed, []);
});

test("takes the path from +++ when it contains ' b/'", () => {
  const diff =
    "diff --git a/x b/y.ts b/x b/y.ts\n--- a/x b/y.ts\n+++ b/x b/y.ts\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(parseDiff(diff)[0].path, "x b/y.ts");
});

test("parses several hunks per file and drops '\\ No newline' markers", () => {
  const diff = fileDiff(
    "a.ts",
    "@@ -1,2 +1,2 @@ fn a\n x\n-y\n+z\n@@ -9 +9,2 @@\n w\n+v\n\\ No newline at end of file\n",
  );
  assert.deepEqual(
    parseDiff(diff)[0].hunks.map((h) => [h.newStart, h.lines]),
    [
      [1, [" x", "-y", "+z"]],
      [9, [" w", "+v"]],
    ],
  );
});

test("empty diff after filtering yields no chunks", () => {
  assert.deepEqual(chunkDiff(LOCK, opts).chunks, []);
});

test("when it does not fit: drops delete-only hunks, main language first, packs whole files up to maxCalls", () => {
  const big = (path: string, n: number) =>
    fileDiff(
      path,
      `@@ -1 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i} of ${path}`).join("\n")}\n`,
    );
  const deleteOnly = fileDiff("src/rm.ts", "@@ -1,2 +1 @@\n keep\n-drop\n");
  const diff = [
    big("src/a.ts", 40),
    big("src/b.ts", 30),
    big("README.md", 50),
    big("src/c.ts", 20),
    deleteOnly,
  ].join("");
  const r = chunkDiff(diff, { maxTokens: 250, maxCalls: 2, ignore: [] });
  // .ts is the main language, so README.md goes last despite being the biggest; c.ts and README.md run out of calls.
  assert.deepEqual(
    r.chunks.map((c) => c.paths),
    [["src/a.ts"], ["src/b.ts"]],
  );
  assert.deepEqual(r.notReviewed, ["src/c.ts", "README.md"]);
  assert.ok(!r.chunks.some((c) => c.text.includes("rm.ts")));
});
