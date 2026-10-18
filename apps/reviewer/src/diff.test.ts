import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_LINES_AFTER,
  CONTEXT_LINES_BEFORE,
  FUNCTION_HEADER_SEARCH_LINES,
} from "./constants.js";
import { addedLines, chunkDiff, extendContext, parseDiff } from "./diff.js";

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

// Expectations derive from the tuning constants, so changing them doesn't break these tests.
const B = CONTEXT_LINES_BEFORE;
const A = CONTEXT_LINES_AFTER;
const SEARCH = FUNCTION_HEADER_SEARCH_LINES;

// A file long enough for any tuning, whose line 2 opens the function that git names in the hunk header.
const FILE_LENGTH = 2 * (B + SEARCH + A) + 20;
const FILE = Array.from({ length: FILE_LENGTH }, (_, i) =>
  i === 1 ? "function login(email) {" : `line ${i + 1}`,
);
const lineNumbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ` line ${from + i}`);
const hunk = (newStart: number, count: number, fn = "") => ({
  header: `@@ -${newStart},${count} +${newStart},${count} @@${fn ? ` ${fn}` : ""}`,
  newStart,
  lines: Array.from({ length: count }, (_, i) => `+changed ${newStart + i}`),
});
const extended = (hunks: ReturnType<typeof hunk>[], lines: string[] | null = FILE) =>
  extendContext([{ path: "a.ts", deleted: false, binary: false, hunks }], () => lines)[0].hunks;

test("extendContext adds CONTEXT_LINES_BEFORE lines before and CONTEXT_LINES_AFTER after, as context", () => {
  const start = B + SEARCH + 5; // far from line 2's function and from the file edges
  const [h] = extended([hunk(start, 2)]);
  assert.equal(h.newStart, start - B);
  assert.deepEqual(h.lines, [
    ...lineNumbers(start - B, start - 1),
    `+changed ${start}`,
    `+changed ${start + 1}`,
    ...lineNumbers(start + 2, start + 1 + A),
  ]);
});

test("extendContext reaches up to the function named in the hunk header", () => {
  const fn = "function login(email) {";
  const [h] = extended([hunk(2 + B + 3, 1, fn)]); // the header is a few lines past the usual context
  assert.equal(h.newStart, 2);
  assert.equal(h.lines[0], ` ${fn}`);
  // Further up than CONTEXT_LINES_BEFORE + FUNCTION_HEADER_SEARCH_LINES: only the usual context.
  const far = 2 + B + SEARCH + 1;
  assert.equal(extended([hunk(far, 1, fn)])[0].newStart, far - B);
});

test("extendContext never overlaps the neighbouring hunk, nor goes past the file edges", () => {
  const start = B + SEARCH + 5;
  // One unchanged line between the hunks: the first one takes it, the second starts right after.
  const [a, b] = extended([hunk(start, 2), hunk(start + 3, 1)]);
  assert.equal(a.lines.at(-1), ` line ${start + 2}`);
  assert.equal(b.newStart, start + 3);
  assert.equal(b.lines[0], `+changed ${start + 3}`);

  assert.equal(extended([hunk(2, 1)])[0].newStart, 1);
  assert.equal(extended([hunk(FILE_LENGTH, 1)])[0].lines.at(-1), `+changed ${FILE_LENGTH}`);
});

test("extendContext leaves files it can't read, and deleted files, as they are", () => {
  assert.deepEqual(extended([hunk(10, 1)], null), [hunk(10, 1)]);
  const deleted = { path: "a.ts", deleted: true, binary: false, hunks: [hunk(10, 1)] };
  assert.deepEqual(extendContext([deleted], () => FILE), [deleted]);
});

test("chunkDiff applies dynamic context only when it gets readLines", () => {
  const diff = fileDiff("a.ts", "@@ -30 +30 @@\n-old\n+changed 30\n");
  assert.doesNotMatch(chunkDiff(diff, opts).chunks[0].text, /line 29/);
  assert.match(chunkDiff(diff, { ...opts, readLines: () => FILE }).chunks[0].text, /^29  line 29$/m);
});

test("addedLines: only the + lines, with their new-file numbers", () => {
  assert.deepEqual([...addedLines(AUTH)], ["src/auth.ts:41", "src/auth.ts:42"]);
  assert.deepEqual([...addedLines(DELETED)], []);
});
