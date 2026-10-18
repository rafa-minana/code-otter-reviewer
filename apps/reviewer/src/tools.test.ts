import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND_MAX_RESULTS, GREP_MAX_MATCHES, READ_FILE_MAX_LINES } from "./constants.js";
import { findRepoFiles, grepRepo, readRepoFile } from "./tools.js";

let tmp: string;
let repo: string;
const hasRipgrep = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsRg = { skip: hasRipgrep ? false : "ripgrep not installed (runs in the reviewer image)" };

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "otter-tools-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "many"));
  writeFileSync(join(tmp, "secret.txt"), "host secret\n");
  writeFileSync(join(repo, "src", "a.ts"), "export function parseConfig() {}\nconst x = parseConfig();\n-flag\n");
  writeFileSync(join(repo, "big.txt"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"));
  writeFileSync(join(repo, ".git", "config"), "parseConfig\n");
  for (let i = 0; i <= FIND_MAX_RESULTS; i++) writeFileSync(join(repo, "many", `f${i}.ts`), "hit\n");
  symlinkSync(join(tmp, "secret.txt"), join(repo, "leak.txt"));
});

after(() => rm(tmp, { recursive: true, force: true }));

test("read_file returns the range numbered like the diff", () => {
  assert.equal(readRepoFile(repo, "src/a.ts", 2, 3), "2  const x = parseConfig();\n3  -flag");
});

test("read_file caps a call at READ_FILE_MAX_LINES and says how to continue", () => {
  const out = readRepoFile(repo, "big.txt").split("\n");
  assert.equal(out.length, READ_FILE_MAX_LINES + 1);
  assert.equal(out.at(-2), `${READ_FILE_MAX_LINES}  line ${READ_FILE_MAX_LINES}`);
  assert.match(out.at(-1)!, new RegExp(`has 500 lines; read more with startLine ${READ_FILE_MAX_LINES + 1}`));
});

test("read_file never leaves the repository and answers in text instead of throwing", () => {
  for (const path of ["../secret.txt", "leak.txt", "missing.ts"]) {
    assert.match(readRepoFile(repo, path), /not found or not readable/);
  }
  assert.equal(readRepoFile(repo, "src/a.ts", 99), "src/a.ts has 3 lines");
});

test("find_files lists relative paths, skips .git and refuses patterns that leave the repo", async () => {
  assert.equal(await findRepoFiles(repo, "src/*.ts"), "src/a.ts");
  assert.equal(await findRepoFiles(repo, "**/config"), "no files match");
  assert.match(await findRepoFiles(repo, "../*.txt"), /must stay inside/);
  assert.match(await findRepoFiles(repo, `${tmp}/*.txt`), /must stay inside/);
});

test("find_files caps the results", async () => {
  const out = (await findRepoFiles(repo, "many/*.ts")).split("\n");
  assert.equal(out.length, FIND_MAX_RESULTS + 1);
  assert.match(out.at(-1)!, /more paths not shown/);
});

test("grep returns path:line:text, without ./ and without .git", needsRg, async () => {
  assert.equal(
    await grepRepo(repo, "parseConfig", "*.ts"),
    ["src/a.ts:1:export function parseConfig() {}", "src/a.ts:2:const x = parseConfig();"].join("\n"),
  );
});

test("grep: a leading '-' is a pattern, not a flag; bad regexes and no matches answer in text", needsRg, async () => {
  assert.equal(await grepRepo(repo, "-flag"), "src/a.ts:3:-flag");
  assert.match(await grepRepo(repo, "("), /grep failed/);
  assert.equal(await grepRepo(repo, "nothing-like-this"), "no matches");
});

test("grep caps the matches", needsRg, async () => {
  const out = (await grepRepo(repo, "^hit$")).split("\n");
  assert.equal(out.length, GREP_MAX_MATCHES + 1);
  assert.match(out.at(-1)!, /more matches not shown/);
});
