// Container entry point: ReviewerRequest on stdin → ReviewerOutput on stdout.
// stdout carries only that JSON; anything else (errors, logs) goes to stderr.
import { text } from "node:stream/consumers";
import type { ReviewerRequest } from "@otter/contracts";
import { review } from "./agent.js";
import { createLlm } from "./llm.js";

/** Where the worker mounts the PR's checkout, read-only. */
const REPO_DIR = "/repo";

try {
  // The request comes from the worker (trusted); the code under /repo does not.
  const { input, finalAttempt } = JSON.parse(
    await text(process.stdin),
  ) as ReviewerRequest;
  const output = await review(
    createLlm(process.env),
    { ...input, repoDir: REPO_DIR },
    { finalAttempt },
  );
  process.stdout.write(JSON.stringify(output));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
