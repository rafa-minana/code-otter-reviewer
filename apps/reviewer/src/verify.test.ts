import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "@otter/contracts";
import type { LlmProvider } from "./llm.js";
import { filterByConfidence, verify } from "./verify.js";

const finding = (line: number, confidence?: number): Finding => ({
  path: "a.ts",
  line,
  side: "RIGHT",
  severity: "major",
  body: `bug ${line}`,
  confidence,
});

test("filterByConfidence keeps findings at or above the threshold", () => {
  const kept = filterByConfidence(
    [finding(1, 0.6), finding(2, 0.7), finding(3, 1)],
    0.7,
  );
  assert.deepEqual(
    kept.map((f) => f.line),
    [2, 3],
  );
});

test("verify maps scores by index; unscored findings get 0 and scores are clamped", async () => {
  const llm: LlmProvider = {
    generate: async () =>
      ({
        scores: [
          { index: 0, score: 8 },
          { index: 2, score: 42 },
        ],
      }) as never,
  };
  const out = await verify(llm, "diff", [finding(1), finding(2), finding(3)]);
  assert.deepEqual(
    out.map((f) => f.confidence),
    [0.8, 0, 1],
  );
});
