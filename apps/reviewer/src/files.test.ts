import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFileReader } from "./files.js";

let tmp: string;
let repo: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "otter-files-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(tmp, "secret.txt"), "host secret\n"); // outside the checkout
  writeFileSync(join(repo, "src", "a.ts"), "one\ntwo\n");
  symlinkSync(join(tmp, "secret.txt"), join(repo, "leak.txt"));
  symlinkSync(tmp, join(repo, "escape")); // a parent directory pointing outside
  symlinkSync(join(repo, "src", "a.ts"), join(repo, "inside.ts"));
});

after(() => rm(tmp, { recursive: true, force: true }));

test("repoFileReader reads regular files of the checkout, without the trailing empty line", () => {
  assert.deepEqual(repoFileReader(repo)("src/a.ts"), ["one", "two"]);
});

test("repoFileReader never follows symlinks, so nothing outside the checkout reaches the LLM", () => {
  const read = repoFileReader(repo);
  assert.equal(read("leak.txt"), null);
  assert.equal(read("escape/secret.txt"), null);
  assert.equal(read("inside.ts"), null); // even an inner symlink: only regular files
  assert.equal(read("../secret.txt"), null);
  assert.equal(read("missing.ts"), null);
});
