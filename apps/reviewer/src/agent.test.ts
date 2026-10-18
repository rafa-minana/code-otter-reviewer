import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewerInput } from "@otter/contracts";
import { review } from "./agent.js";
import type { LlmProvider } from "./llm.js";

const fileDiff = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n x\n+y\n`;

const input = (diff: string, config: unknown = {}): ReviewerInput => ({
  title: "t",
  description: "d",
  diff,
  config,
  previousFindings: [],
});

type Req = Parameters<LlmProvider["generate"]>[0];
const isVerify = (req: Req) => req.system.includes("checking another reviewer");

/** Fake LLM: `reviewOut` answers review calls; verify calls score every finding with `score` (or throw). */
function fakeLlm(reviewOut: (req: Req) => unknown, score: number | Error = 9) {
  const calls: Req[] = [];
  const llm: LlmProvider = {
    async generate(req) {
      calls.push(req);
      if (!isVerify(req)) return reviewOut(req) as never;
      if (score instanceof Error) throw score;
      const n = JSON.parse(
        req.prompt.slice(
          req.prompt.indexOf("["),
          req.prompt.lastIndexOf("]") + 1,
        ),
      ).length;
      return {
        scores: Array.from({ length: n }, (_, index) => ({ index, score })),
      } as never;
    },
  };
  return { llm, calls };
}

const f = (line: number, severity = "major", body = `bug ${line}`) => ({
  path: "a.ts",
  line,
  severity,
  body,
});

test("caps findings per chunk, sets side RIGHT and keeps the verifier's confidence", async () => {
  const { llm } = fakeLlm(() => ({
    summary: "s",
    risk: "low",
    findings: [f(1), f(2), f(3), f(4)],
  }));
  const out = await review(llm, input(fileDiff("a.ts")));
  assert.deepEqual(
    out.findings.map((x) => [x.line, x.side, x.confidence]),
    [
      [1, "RIGHT", 0.9],
      [2, "RIGHT", 0.9],
      [3, "RIGHT", 0.9],
    ],
  );
});

test("drops findings below REVIEW_MIN_SCORE", async () => {
  const { llm } = fakeLlm(
    () => ({ summary: "s", risk: "low", findings: [f(1)] }),
    6,
  );
  assert.deepEqual((await review(llm, input(fileDiff("a.ts")))).findings, []);
});

test("verifier failure: rethrows before the last attempt, keeps only critical/major unverified on the last", async () => {
  const reviewOut = () => ({
    summary: "s",
    risk: "low",
    findings: [f(1, "critical"), f(2, "minor"), f(3, "major"), f(4, "nit")],
  });
  const { llm } = fakeLlm(reviewOut, new Error("429"));
  await assert.rejects(
    review(llm, input(fileDiff("a.ts")), { finalAttempt: false }),
    /429/,
  );
  const out = await review(llm, input(fileDiff("a.ts")));
  assert.deepEqual(
    out.findings.map((x) => [x.line, x.confidence]),
    [
      [1, undefined],
      [3, undefined],
    ],
  );
});

test("applies .otter.yaml: ignore globs and per-path instructions in the system prompt", async () => {
  const { llm, calls } = fakeLlm(() => ({
    summary: "s",
    risk: "low",
    findings: [],
  }));
  const config = {
    ignore: ["gen/**"],
    instructions: [
      { path: "src/**", text: "check auth" },
      { path: "docs/**", text: "ignore me" },
    ],
  };
  const out = await review(
    llm,
    input(fileDiff("src/a.ts") + fileDiff("gen/b.ts"), config),
  );
  assert.deepEqual(out.filtered, ["gen/b.ts"]);
  assert.match(calls[0].system, /check auth/);
  assert.doesNotMatch(calls[0].system, /ignore me/);
  assert.match(calls[0].prompt, /<untrusted>/);
});

test("rejects an invalid .otter.yaml with a clear error", async () => {
  const { llm } = fakeLlm(() => ({}));
  await assert.rejects(
    review(llm, input(fileDiff("a.ts"), { ignore: "src" })),
    /invalid \.otter\.yaml/,
  );
});

test("merges chunks: union without duplicates, most conservative risk", async () => {
  // Each file is ~21k tokens: together they exceed the 32k budget, so each goes in its own chunk.
  const big = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2000 @@\n${"+xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(2000)}`;
  let n = 0;
  const { llm, calls } = fakeLlm(() => ({
    summary: `s${++n}`,
    risk: n === 1 ? "low" : "high",
    findings: [f(1, "major", "same"), f(10 + n)],
  }));
  const out = await review(llm, input(big("a.ts") + big("b.ts")));
  assert.equal(calls.filter((c) => !isVerify(c)).length, 2);
  assert.equal(out.risk, "high");
  assert.equal(out.summary, "s1\n\ns2");
  assert.deepEqual(
    out.findings.map((x) => x.line),
    [1, 11, 12],
  );
});

test("no reviewable files: no LLM calls, low risk", async () => {
  const { llm, calls } = fakeLlm(() => ({}));
  const out = await review(llm, input(fileDiff("package-lock.json")));
  assert.equal(calls.length, 0);
  assert.equal(out.risk, "low");
  assert.deepEqual(out.filtered, ["package-lock.json"]);
});
