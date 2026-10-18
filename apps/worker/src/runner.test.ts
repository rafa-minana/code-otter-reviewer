import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReviewToken } from "@otter/gateway/token.js";
import { dockerRunArgs, REVIEWER_LLM_ENV, reviewerEnv } from "./runner.js";

const SECRET = "s".repeat(32);
const cfg = {
  image: "code-otter-reviewer",
  network: "otter-reviewers",
  gatewayUrl: "http://otter-gateway:8080",
  gatewaySecret: SECRET,
};
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

test("only the LLM variables pass, by name: no value ever appears in the arguments", () => {
  assert.deepEqual(allValuesOf("-e"), REVIEWER_LLM_ENV);
  assert.ok(allValuesOf("-e").every((v) => /^LLM_[A-Z_]+$/.test(v)), "names only, never NAME=value");
  assert.ok(!REVIEWER_LLM_ENV.some((v) => v.startsWith("GITHUB_") || v === "DATABASE_URL"));
});

test("the container sits on the configured internal network", () => {
  assert.equal(valueOf("--network"), "otter-reviewers");
});

test("the container talks to the gateway with this review's token, never the real key", () => {
  const now = 1_700_000_000_000;
  const base = { PATH: "/bin", LLM_API_KEY: "sk-real", LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "m" };
  const env = reviewerEnv(cfg, "7", base, now);
  assert.equal(env.LLM_BASE_URL, "http://otter-gateway:8080");
  assert.equal(verifyReviewToken(SECRET, env.LLM_API_KEY, now)?.reviewId, "7");
  assert.ok(!Object.values(env).includes("sk-real"));
  assert.equal(env.LLM_MODEL, "m", "the rest of the LLM settings still pass");
  assert.equal(env.PATH, "/bin", "the docker CLI keeps its own environment");
});
