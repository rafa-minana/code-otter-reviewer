import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerRunArgs, REVIEWER_LLM_ENV } from "./runner.js";

const cfg = { image: "code-otter-reviewer", network: "otter-internal" };
const args = dockerRunArgs(cfg, "/var/otter/worktrees/acme/app/pr1/abc", "otter-review-7");
const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
const allValuesOf = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test("the reviewer container gets the checkout read-only, and nothing else from the host", () => {
  assert.deepEqual(allValuesOf("-v"), ["/var/otter/worktrees/acme/app/pr1/abc:/repo:ro"]);
  assert.equal(valueOf("--name"), "otter-review-7");
  assert.equal(args.at(-1), "code-otter-reviewer"); // the image goes last: nothing after it reaches the CLI
});

test("the container runs without privileges, on a read-only filesystem, with bounded resources", () => {
  for (const flag of ["--rm", "-i", "--read-only"]) assert.ok(args.includes(flag), flag);
  assert.equal(valueOf("--cap-drop"), "ALL");
  assert.equal(valueOf("--security-opt"), "no-new-privileges");
  assert.equal(valueOf("--pull"), "never");
  assert.ok(valueOf("--memory") && valueOf("--cpus") && valueOf("--pids-limit"));
});

test("only the LLM variables pass, by name: the key's value never appears in the arguments", () => {
  assert.deepEqual(allValuesOf("-e"), REVIEWER_LLM_ENV);
  assert.ok(allValuesOf("-e").every((v) => /^LLM_[A-Z_]+$/.test(v)), "names only, never NAME=value");
  assert.ok(!REVIEWER_LLM_ENV.some((v) => v.startsWith("GITHUB_") || v === "DATABASE_URL"));
});

test("the network is configurable, ready for the LLM gateway (plan 6)", () => {
  assert.equal(valueOf("--network"), "otter-internal");
});
